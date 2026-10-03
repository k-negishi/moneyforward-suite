import { chromium } from 'playwright'
import type { Locator, Page } from 'playwright'

import {
  ACCOUNT_ROW_STRATEGIES,
  AUTH_CHALLENGE_INPUT_SELECTOR,
  BULK_UPDATE_CONTROL_STRATEGIES,
  ME_ACCOUNTS_URL,
  NAVIGATION_TIMEOUT_MS,
  REFRESH_POLL_INTERVAL_MS,
  ROW_CHANGE_TIMEOUT_MS,
  TARGET_WAIT_TIMEOUT_MS,
  isSignInUrl,
  resolveSessionFilePath,
} from './config.js'
import type { LocatorRoot, LocatorStrategy } from './config.js'
import { EXIT_CODE_BY_STATUS, REFRESH_USAGE, parseRefreshArgs } from './refresh-cli.js'
import type { RefreshOptions, SpikeStatus } from './refresh-cli.js'
import { readSessionFile } from './session.js'
import { classifyAuthState, detectRowChanges, isRowSnapshotValid } from './state.js'
import type { AuthStateSignals } from './state.js'

/**
 * 金融機関のデータ一括更新を実行し、行ごとの変化（受付）を確認する spike CLI。
 * 手動更新と同じ導線（口座一覧ページの一括更新コントロール）を使う。
 * 実機では一括更新は行ごとに処理され、メッセージ・ページ遷移は無く、行のスピナー表示と
 * 更新日時の変化で確認できる。そのためクリック前後の行テキストを比較し、変化または
 * 進行中シグナルの新規出現で受付を判定する（ADR-0020）。
 * ・URL / Selector / 操作を引数で受け付けない（ADR-0010）
 * ・出力は status=... のみ（金額・カード番号・Cookie・セッション・URL は出さない）
 * ・Screenshot / HTML dump / HAR / Trace / Video を保存しない（ADR-0017）
 */

/**
 * Locator 探索の結果。
 */
type Resolution =
  | { readonly status: 'RESOLVED'; readonly locator: Locator }
  | { readonly status: 'TARGET_NOT_FOUND' }
  | { readonly status: 'TARGET_AMBIGUOUS' }

/**
 * 優先順位どおりに Locator を試し、可視要素が最初に現れた戦略を採用する。
 * 可視要素だけを待つ（先頭が非表示でも、可視の一致があればその戦略を採用する）。
 * 一致が複数の場合は取り違えを避けるため曖昧として停止する（fail closed）。
 */
const resolveTarget = async (
  root: LocatorRoot,
  strategies: readonly LocatorStrategy[],
): Promise<Resolution> => {
  for (const strategy of strategies) {
    const visibleMatches = strategy(root).filter({ visible: true })
    const appeared = await visibleMatches
      .first()
      .waitFor({ state: 'visible', timeout: TARGET_WAIT_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false)
    if (!appeared) continue

    if ((await visibleMatches.count()) > 1) return { status: 'TARGET_AMBIGUOUS' }
    return { status: 'RESOLVED', locator: visibleMatches.first() }
  }
  return { status: 'TARGET_NOT_FOUND' }
}

/**
 * 要素の可視テキストを取得する。金融情報・DOM を含み得るため、ログ・例外へは出さない。
 * 取得できない場合は空文字を返し、呼び出し側の判定（変化なし）で停止させる。
 */
const readLocatorText = async (locator: Locator): Promise<string> => {
  try {
    return await locator.innerText({ timeout: TARGET_WAIT_TIMEOUT_MS })
  } catch {
    return ''
  }
}

/** ページ全体の可視テキストを取得する（認証チャレンジ文言の探索用。取得できなければ空文字）。 */
const readVisibleText = (page: Page): Promise<string> => readLocatorText(page.locator('body'))

/**
 * 認証状態の観測値をページから集める（分類は state.ts の純関数が行う）。
 * 入力欄は可視のものだけを数える（非表示のテンプレートや過去のフォームを拾わない）。
 */
const collectAuthStateSignals = async (page: Page): Promise<AuthStateSignals> => ({
  isSignInUrl: isSignInUrl(page.url()),
  visibleText: await readVisibleText(page),
  visibleChallengeInputCount: await page
    .locator(AUTH_CHALLENGE_INPUT_SELECTOR)
    .filter({ visible: true })
    .count(),
})

/**
 * 認証状態を確認し、続行可否を返す。
 * 未認証（sign_in へのリダイレクト・認証チャレンジ）は AUTH_REQUIRED、
 * 本文を取得できず判定できない場合は TEMPORARY_FAILURE（fail closed）。
 */
const checkAuthentication = async (
  page: Page,
): Promise<'OK' | 'AUTH_REQUIRED' | 'TEMPORARY_FAILURE'> => {
  const authState = classifyAuthState(await collectAuthStateSignals(page))
  if (authState === 'AUTHENTICATED') return 'OK'
  return authState === 'UNKNOWN' ? 'TEMPORARY_FAILURE' : 'AUTH_REQUIRED'
}

/**
 * 更新対象の口座行（「更新」コントロールを含む行）を可視のものだけ列挙する。
 * 複数一致が正常（対象の口座が複数ある）のため、resolveTarget とは別に扱う。
 * どの戦略でも見つからない場合は null を返す（呼び出し側が停止する。fail closed）。
 */
const collectAccountRows = async (page: Page): Promise<readonly Locator[] | null> => {
  for (const strategy of ACCOUNT_ROW_STRATEGIES) {
    const visibleRows = strategy(page).filter({ visible: true })
    const appeared = await visibleRows
      .first()
      .waitFor({ state: 'visible', timeout: TARGET_WAIT_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false)
    if (!appeared) continue

    const count = await visibleRows.count()
    return Array.from({ length: count }, (_, index) => visibleRows.nth(index))
  }
  return null
}

/** 行の可視テキストをまとめて取得する（取得できない行は空文字。ログ・例外へは出さない）。 */
const readRowsText = (rows: readonly Locator[]): Promise<readonly string[]> =>
  Promise.all(rows.map((row) => readLocatorText(row)))

/** クリック前スナップショットの確定を試みる回数と間隔（表示直後の再描画で空テキストになるため）。 */
const ROW_SNAPSHOT_ATTEMPTS = 3
const ROW_SNAPSHOT_RETRY_INTERVAL_MS = 200

/**
 * 空文字の行を含まない有効なスナップショットが得られるまで、短間隔で取得を再試行する。
 * 確定できない場合は null を返す（呼び出し側がクリックせずに停止する。fail closed）。
 */
const readValidRowsSnapshot = async (
  page: Page,
  rows: readonly Locator[],
): Promise<readonly string[] | null> => {
  for (let attempt = 0; attempt < ROW_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const snapshot = await readRowsText(rows)
    if (isRowSnapshotValid(snapshot)) return snapshot
    if (attempt < ROW_SNAPSHOT_ATTEMPTS - 1) {
      await page.waitForTimeout(ROW_SNAPSHOT_RETRY_INTERVAL_MS)
    }
  }
  return null
}

/**
 * 一括更新のクリック後、行の変化（受付）を確認できるまで観測を繰り返す。
 * 進行中シグナルの新規出現、またはいずれかの行のテキスト変化で受付成立（true）。
 * 空文字の行を含む観測や行数が減った観測（再描画・デタッチ中）は無効として使わず、
 * 次のポーリングへ進む。失敗文言の出現を検知した場合と、タイムアウトまで変化が無い場合は
 * false（呼び出し側が fail closed で TEMPORARY_FAILURE にする）。
 */
const waitForRowChanges = async (page: Page, beforeRows: readonly string[]): Promise<boolean> => {
  const deadline = Date.now() + ROW_CHANGE_TIMEOUT_MS

  for (;;) {
    const rows = await collectAccountRows(page)
    if (rows !== null) {
      const rowsAfter = await readRowsText(rows)
      const evidence = detectRowChanges(beforeRows, rowsAfter)
      if (evidence.valid) {
        if (evidence.failureDetected) return false
        if (evidence.changedCount > 0 || evidence.inProgressAppeared) return true
      }
    }

    if (Date.now() >= deadline) return false
    await page.waitForTimeout(REFRESH_POLL_INTERVAL_MS)
  }
}

/** 更新の確認と実行の本体。Browser は全経路で finally により close する。 */
const run = async (options: RefreshOptions): Promise<SpikeStatus> => {
  const session = readSessionFile(resolveSessionFilePath())
  if (session.status !== 'OK') return session.status

  const browser = await chromium.launch({ headless: options.headless })
  try {
    // 破損した storageState で newContext が投げる場合も、セッションの問題として区別して停止する。
    const context = await browser
      .newContext({ storageState: session.storageState })
      .catch(() => null)
    if (context === null) return 'SESSION_INVALID'

    const page = await context.newPage()
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS)

    // ダイアログは自動で承認しない（fail closed）。出現したら閉じるだけにする。
    page.on('dialog', (dialog) => {
      void dialog.dismiss().catch(() => undefined)
    })

    // 手動更新と同じ導線: 口座一覧ページを開く。
    await page.goto(ME_ACCOUNTS_URL, { waitUntil: 'domcontentloaded' })
    const authAfterLoad = await checkAuthentication(page)
    if (authAfterLoad !== 'OK') return authAfterLoad

    // 一括更新コントロールの特定: ページ全体から探す（0 件・複数件は停止）。
    const bulkControl = await resolveTarget(page, BULK_UPDATE_CONTROL_STRATEGIES)
    if (bulkControl.status !== 'RESOLVED') return bulkControl.status

    // 更新対象の口座行（「更新」コントロールを含む行）を列挙する。
    const accountRows = await collectAccountRows(page)
    if (accountRows === null) return 'TARGET_NOT_FOUND'

    // 既定は読み取りのみ。一括更新コントロールと対象行の特定まで確認して終了する。
    if (!options.execute) return 'REFRESH_AVAILABLE'

    // クリック前の比較基準を有効な観測として確定する。確定できない場合はクリックしない
    // （無効な基準では受付を確認できず、長いタイムアウトを空費するため）。
    const rowsBefore = await readValidRowsSnapshot(page, accountRows)
    if (rowsBefore === null) return 'TEMPORARY_FAILURE'

    // 金融機関のデータ一括更新を実行し、行ごとの受付を観測する。
    // クリックには明示タイムアウトを付ける（要素の消滅等で既定の長い待機に引きずられない）。
    const clicked = await bulkControl.locator
      .click({ timeout: TARGET_WAIT_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false)
    // クリックできなければ状態変化を確認できないため、受付としない（fail closed）。
    if (!clicked) return 'TEMPORARY_FAILURE'

    // クリック後にセッションが失効していないか確認する（失効時は再ログインが必要なため停止する）。
    const authAfterClick = await checkAuthentication(page)
    if (authAfterClick !== 'OK') return authAfterClick

    // 行の変化（受付）が確認できれば受理。失敗検知・変化なしは fail closed で停止する。
    return (await waitForRowChanges(page, rowsBefore)) ? 'REFRESH_ACCEPTED' : 'TEMPORARY_FAILURE'
  } finally {
    await browser.close()
  }
}

const main = async (): Promise<number> => {
  const options = parseRefreshArgs(process.argv.slice(2))
  if (options === null) {
    console.error(REFRESH_USAGE)
    return 1
  }

  try {
    const status = await run(options)
    console.log(`status=${status}`)
    return EXIT_CODE_BY_STATUS[status]
  } catch {
    // 例外の内容は出さない（URL・DOM・Cookie が混ざり得るため）。
    console.log('status=TEMPORARY_FAILURE')
    return 1
  }
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode
  })
  .catch(() => {
    console.log('status=TEMPORARY_FAILURE')
    process.exitCode = 1
  })
