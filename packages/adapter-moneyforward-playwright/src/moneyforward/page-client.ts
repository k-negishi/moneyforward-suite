import { chromium } from 'playwright'
import type { Browser, BrowserContext, Locator, Page } from 'playwright'

import { saveSessionState } from '@mf-suite/security'
import type { SessionState } from '@mf-suite/security'

import { authStateToLoginStatus, classifyAuthState } from './auth-state.js'
import type { AuthStateSignals } from './auth-state.js'
import {
  ACCOUNT_ROW_STRATEGIES,
  AUTH_CHALLENGE_INPUT_SELECTOR,
  BULK_UPDATE_CONTROL_STRATEGIES,
  LOGIN_URL,
  ME_ACCOUNTS_URL,
  ME_HOME_URL,
  NAVIGATION_TIMEOUT_MS,
  REFRESH_POLL_INTERVAL_MS,
  ROW_CHANGE_TIMEOUT_MS,
  TARGET_WAIT_TIMEOUT_MS,
  isSignInUrl,
} from './locators.js'
import type { LocatorRoot, LocatorStrategy } from './locators.js'
import { detectRowChanges, isRowSnapshotValid } from './row-changes.js'
import type { RowChangeEvidence } from './row-changes.js'

/**
 * Playwright による MoneyForward ME のページ操作。
 * 手動更新と同じ導線（口座一覧ページの一括更新コントロール）を使う。
 * 実機では一括更新は行ごとに処理され、メッセージ・ページ遷移は無く、行のスピナー表示と
 * 更新日時の変化で確認できる。そのためクリック前後の行テキストを比較し、変化または
 * 進行中シグナルの新規出現で受付を判定する（ADR-0020）。
 * ・URL / Selector / 操作を引数で受け付けない（ADR-0010）
 * ・戻り値は状態識別子・件数・真偽値のみ（金額・カード番号・Cookie・セッション・URL・行テキストは返さない）
 * ・Screenshot / HTML dump / HAR / Trace / Video を保存しない（ADR-0017）
 * Page / Locator はこのモジュールの外へ出さない（呼び出し側は構造化した結果だけを受け取る）。
 */

/** Playwright の storageState() が返す構造の型。 */
type PlaywrightStorageState = Awaited<ReturnType<BrowserContext['storageState']>>

/**
 * セッション状態（自前構造）を Playwright の storageState へ写す。
 * 宣言済みのフィールドは型で固定し、宣言に無いフィールド（例: 分割 Cookie の partitionKey）は
 * 保存されていた値をそのまま透過させる（往復で失わせない）。
 */
export const toStorageState = (sessionState: SessionState): PlaywrightStorageState => ({
  ...sessionState,
  cookies: sessionState.cookies.map((cookie) => ({ ...cookie })),
  origins: sessionState.origins.map((origin) => ({
    ...origin,
    localStorage: origin.localStorage.map((entry) => ({ ...entry })),
  })),
})

/**
 * Playwright の storageState を、保存用のセッション状態（自前構造）へ写す。
 * 宣言済みのフィールドは型で固定し、宣言に無いフィールドも保存形式へそのまま引き継ぐ
 * （Playwright の宣言型と互換の範囲で往復させる）。
 */
export const toSessionState = (storageState: PlaywrightStorageState): SessionState => ({
  ...storageState,
  cookies: storageState.cookies.map((cookie) => ({ ...cookie })),
  origins: storageState.origins.map((origin) => ({
    ...origin,
    localStorage: origin.localStorage.map((entry) => ({ ...entry })),
  })),
})

/** 操作を続行できない理由（core の ErrorCode と同じ語彙。Adapter が Result へ写す）。 */
export type RefreshBlocked =
  | 'AUTH_REQUIRED'
  | 'SESSION_INVALID'
  | 'TARGET_NOT_FOUND'
  | 'TARGET_AMBIGUOUS'
  | 'TEMPORARY_FAILURE'

/** クリック後の受付の観測結果（件数と真偽値のみ。core の観測型へ写せる形）。 */
export interface RefreshObservation {
  readonly acceptance: 'ACCEPTED' | 'NOT_ACCEPTED'
  readonly observedRowCount: number
  readonly changedRowCount: number
  readonly failedRowCount: number
  readonly inProgressAppeared: boolean
  readonly authLost: boolean
}

/** 更新可否の確認（読み取りのみ）の結果。 */
export type RefreshTargetsOutcome =
  | { readonly status: 'AVAILABLE' }
  | { readonly status: RefreshBlocked }

/** 一括更新の実行結果。OBSERVED は受付の確認まで進んだことを表す。 */
export type RefreshExecutionOutcome =
  | { readonly status: 'OBSERVED'; readonly observation: RefreshObservation }
  | { readonly status: RefreshBlocked }

/** 手動ログインのセッション確立の結果。NOT_COMPLETED はユーザー操作の未完了（EOF 等）を表す。 */
export type LoginSessionResult =
  | { readonly status: 'SESSION_SAVED' }
  | { readonly status: 'NOT_COMPLETED' }
  | { readonly status: 'AUTH_REQUIRED' }
  | { readonly status: 'TEMPORARY_FAILURE' }

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
 * 認証状態の観測値をページから集める（分類は auth-state.ts の純関数が行う）。
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

/** 操作の準備が整ったページ。browser の close は呼び出し側が finally で行う。 */
interface PreparedPage {
  readonly browser: Browser
  readonly page: Page
  readonly bulkControl: Locator
  readonly accountRows: readonly Locator[]
}

/** ページの準備結果。BLOCKED の場合、ブラウザは閉じたうえで理由だけを返す。 */
type PagePreparation =
  | { readonly status: 'READY'; readonly prepared: PreparedPage }
  | { readonly status: 'BLOCKED'; readonly reason: RefreshBlocked }

/** ブラウザを閉じてから、続行できない理由を返す。 */
const blocked = async (browser: Browser, reason: RefreshBlocked): Promise<PagePreparation> => {
  await browser.close().catch(() => undefined)
  return { status: 'BLOCKED', reason }
}

/**
 * ブラウザを起動し、口座一覧ページを開いて認証確認と対象の特定までを行う。
 * 続行できない場合はブラウザを閉じて理由を返す。READY の場合の close は呼び出し側の責務。
 * 起動・遷移の例外はそのまま投げる（呼び出し側が Result へ写す）。
 */
const preparePage = async (
  sessionState: SessionState,
  options: { readonly headless: boolean },
): Promise<PagePreparation> => {
  const browser = await chromium.launch({ headless: options.headless })
  try {
    // 破損した storageState で newContext が投げる場合も、セッションの問題として区別して停止する。
    const context = await browser
      .newContext({ storageState: toStorageState(sessionState) })
      .catch(() => null)
    if (context === null) return blocked(browser, 'SESSION_INVALID')

    const page = await context.newPage()
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS)

    // ダイアログは自動で承認しない（fail closed）。出現したら閉じるだけにする。
    page.on('dialog', (dialog) => {
      void dialog.dismiss().catch(() => undefined)
    })

    // 手動更新と同じ導線: 口座一覧ページを開く。
    await page.goto(ME_ACCOUNTS_URL, { waitUntil: 'domcontentloaded' })
    const authAfterLoad = await checkAuthentication(page)
    if (authAfterLoad !== 'OK') return blocked(browser, authAfterLoad)

    // 一括更新コントロールの特定: ページ全体から探す（0 件・複数件は停止）。
    const bulkControl = await resolveTarget(page, BULK_UPDATE_CONTROL_STRATEGIES)
    if (bulkControl.status !== 'RESOLVED') return blocked(browser, bulkControl.status)

    // 更新対象の口座行（「更新」コントロールを含む行）を列挙する。
    const accountRows = await collectAccountRows(page)
    if (accountRows === null) return blocked(browser, 'TARGET_NOT_FOUND')

    return {
      status: 'READY',
      prepared: { browser, page, bulkControl: bulkControl.locator, accountRows },
    }
  } catch (error) {
    await browser.close().catch(() => undefined)
    throw error
  }
}

/**
 * セッションの有効性を検証する（口座一覧ページを開いて認証状態を確認する）。
 * 認証済みなら VALID、未認証（リダイレクト・認証チャレンジ）は AUTH_REQUIRED。
 * セッションを適用できない・本文を取得できない場合は UNKNOWN（判定不能。呼び出し側が fail closed で扱う）。
 */
export const checkSession = async (
  sessionState: SessionState,
  options: { readonly headless: boolean },
): Promise<'VALID' | 'AUTH_REQUIRED' | 'UNKNOWN'> => {
  const browser = await chromium.launch({ headless: options.headless })
  try {
    const context = await browser
      .newContext({ storageState: toStorageState(sessionState) })
      .catch(() => null)
    if (context === null) return 'UNKNOWN'

    const page = await context.newPage()
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS)

    await page.goto(ME_ACCOUNTS_URL, { waitUntil: 'domcontentloaded' })
    const authCheck = await checkAuthentication(page)
    if (authCheck === 'OK') return 'VALID'
    return authCheck === 'AUTH_REQUIRED' ? 'AUTH_REQUIRED' : 'UNKNOWN'
  } finally {
    await browser.close()
  }
}

/**
 * 更新可否の確認（読み取りのみ）。
 * 口座一覧ページを開き、認証確認と対象（一括更新コントロール・口座行）の特定まで行う。
 */
export const inspectRefreshTargets = async (
  sessionState: SessionState,
  options: { readonly headless: boolean },
): Promise<RefreshTargetsOutcome> => {
  const preparation = await preparePage(sessionState, options)
  if (preparation.status !== 'READY') return { status: preparation.reason }

  try {
    return { status: 'AVAILABLE' }
  } finally {
    await preparation.prepared.browser.close()
  }
}

/** 行変化の証拠を、受付の観測結果へ写す（件数と真偽値のみ。行テキストは含めない）。 */
const toObservation = (
  observedRowCount: number,
  evidence: RowChangeEvidence,
): RefreshObservation => {
  const accepted =
    !evidence.failureDetected && (evidence.changedCount > 0 || evidence.inProgressAppeared)
  return {
    acceptance: accepted ? 'ACCEPTED' : 'NOT_ACCEPTED',
    observedRowCount,
    changedRowCount: evidence.changedCount,
    failedRowCount: evidence.failureDetected ? 1 : 0,
    inProgressAppeared: evidence.inProgressAppeared,
    authLost: false,
  }
}

/**
 * 一括更新のクリック後、行の変化（受付）を確認できるまで観測を繰り返す。
 * 進行中シグナルの新規出現、またはいずれかの行のテキスト変化で受理とする。
 * 空文字の行を含む観測や行数が減った観測（再描画・デタッチ中）は無効として使わず、次のポーリングへ進む。
 * 失敗文言の出現を検知した場合と、タイムアウトまで変化が無い場合は不受理として観測を返す。
 */
const waitForAcceptance = async (
  page: Page,
  beforeRows: readonly string[],
): Promise<RefreshObservation> => {
  const deadline = Date.now() + ROW_CHANGE_TIMEOUT_MS
  let lastEvidence: RowChangeEvidence = {
    valid: false,
    changedCount: 0,
    inProgressAppeared: false,
    failureDetected: false,
  }

  for (;;) {
    const rows = await collectAccountRows(page)
    if (rows !== null) {
      const rowsAfter = await readRowsText(rows)
      const evidence = detectRowChanges(beforeRows, rowsAfter)
      if (evidence.valid) {
        lastEvidence = evidence
        if (evidence.failureDetected || evidence.changedCount > 0 || evidence.inProgressAppeared) {
          return toObservation(beforeRows.length, evidence)
        }
      }
    }

    if (Date.now() >= deadline) return toObservation(beforeRows.length, lastEvidence)
    await page.waitForTimeout(REFRESH_POLL_INTERVAL_MS)
  }
}

/**
 * 金融機関のデータ一括更新を実行し、行ごとの受付を観測する。
 * クリックの成否では判定せず、行の変化という状態変化で判定する（ADR-0020）。
 * 受付を確認できない場合・失敗を検知した場合は OBSERVED（NOT_ACCEPTED）として返し、
 * 操作を続行できない場合は理由（RefreshBlocked）を返す。呼び出し側が Result へ写す。
 */
export const executeRefresh = async (
  sessionState: SessionState,
  options: { readonly headless: boolean },
): Promise<RefreshExecutionOutcome> => {
  const preparation = await preparePage(sessionState, options)
  if (preparation.status !== 'READY') return { status: preparation.reason }

  const { browser, page, bulkControl, accountRows } = preparation.prepared
  try {
    // クリック前の比較基準を有効な観測として確定する。確定できない場合はクリックしない
    // （無効な基準では受付を確認できず、長いタイムアウトを空費するため）。
    const rowsBefore = await readValidRowsSnapshot(page, accountRows)
    if (rowsBefore === null) return { status: 'TEMPORARY_FAILURE' }

    // 金融機関のデータ一括更新を実行する。
    // クリックには明示タイムアウトを付ける（要素の消滅等で既定の長い待機に引きずられない）。
    const clicked = await bulkControl
      .click({ timeout: TARGET_WAIT_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false)
    // クリックできなければ状態変化を確認できないため、受付としない（fail closed）。
    if (!clicked) return { status: 'TEMPORARY_FAILURE' }

    // クリック後にセッションが失効していないか確認する（失効時は再ログインが必要なため停止する）。
    const authAfterClick = await checkAuthentication(page)
    if (authAfterClick === 'AUTH_REQUIRED') {
      // 操作は実行したが受付は確認していない。認証が失われたことを観測として返し、
      // 呼び出し側が受付の有無によらず認証要求として扱えるようにする（fail closed）。
      return {
        status: 'OBSERVED',
        observation: {
          acceptance: 'NOT_ACCEPTED',
          observedRowCount: rowsBefore.length,
          changedRowCount: 0,
          failedRowCount: 0,
          inProgressAppeared: false,
          authLost: true,
        },
      }
    }
    if (authAfterClick === 'TEMPORARY_FAILURE') return { status: 'TEMPORARY_FAILURE' }

    // 行の変化（受付）が確認できれば受理。失敗検知・変化なしは不受理として観測を返す。
    return { status: 'OBSERVED', observation: await waitForAcceptance(page, rowsBefore) }
  } finally {
    await browser.close()
  }
}

/**
 * 手動ログインのセッションを確立する。
 * headed ブラウザでログイン画面を開き、waitForLogin の完了後にログイン状態を確認して
 * セッションを保存する。未認証・判定不能の場合は保存しない（fail closed）。
 * waitForLogin はログイン画面を開いた後に呼ばれる（CLI が案内の表示と待機を行う）。
 */
export const runManualLoginSession = async (
  sessionFilePath: string,
  waitForLogin: () => Promise<boolean>,
): Promise<LoginSessionResult> => {
  const browser = await chromium.launch({ headless: false })
  try {
    const context = await browser.newContext()
    const page = await context.newPage()
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS)

    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' })

    const completed = await waitForLogin()
    if (!completed) return { status: 'NOT_COMPLETED' }

    // ログイン状態を三値で判定し、結果へ写す。未認証は AUTH_REQUIRED、
    // 判定不能（本文取得失敗）は TEMPORARY_FAILURE として、いずれも保存しない（fail closed）。
    await page.goto(ME_HOME_URL, { waitUntil: 'domcontentloaded' })
    const loginStatus = authStateToLoginStatus(
      classifyAuthState(await collectAuthStateSignals(page)),
    )
    if (loginStatus !== 'SESSION_SAVED') return { status: loginStatus }

    saveSessionState(sessionFilePath, toSessionState(await context.storageState()))
    return { status: 'SESSION_SAVED' }
  } finally {
    // 成功・失敗のどちらでもブラウザを閉じる。
    await browser.close()
  }
}
