import type { SessionState } from '@mf-suite/security'
import type { Browser, BrowserContext, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import type { AuthStateSignals } from './auth-state.js'
import { classifyAuthState } from './auth-state.js'
import type { LocatorRoot, LocatorStrategy } from './locators.js'
import {
  ACCOUNT_ROW_STRATEGIES,
  AUTH_CHALLENGE_INPUT_SELECTOR,
  BULK_UPDATE_CONTROL_STRATEGIES,
  isSignInUrl,
  ME_ACCOUNTS_URL,
  NAVIGATION_TIMEOUT_MS,
  TARGET_WAIT_TIMEOUT_MS,
} from './locators.js'
import { isRowSnapshotValid } from './row-changes.js'

/**
 * ページ操作の下位ヘルパー。セッション状態の相互変換、認証確認、Locator 探索、ページ準備を担う。
 * 公開 API（セッション検証・更新可否の確認・一括更新の実行・手動ログイン）は page-client に置き、
 * 依存は page-client → page-helpers の一方向に保つ（受付の観測は page-client 側にある）。
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
    if (!appeared) {
      continue
    }

    if ((await visibleMatches.count()) > 1) {
      return { status: 'TARGET_AMBIGUOUS' }
    }
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
export const collectAuthStateSignals = async (page: Page): Promise<AuthStateSignals> => ({
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
export const checkAuthentication = async (
  page: Page,
): Promise<'OK' | 'AUTH_REQUIRED' | 'TEMPORARY_FAILURE'> => {
  const authState = classifyAuthState(await collectAuthStateSignals(page))
  if (authState === 'AUTHENTICATED') {
    return 'OK'
  }
  return authState === 'UNKNOWN' ? 'TEMPORARY_FAILURE' : 'AUTH_REQUIRED'
}

/**
 * 更新対象の口座行（「更新」コントロールを含む行）を可視のものだけ列挙する。
 * 複数一致が正常（対象の口座が複数ある）のため、resolveTarget とは別に扱う。
 * どの戦略でも見つからない場合は null を返す（呼び出し側が停止する。fail closed）。
 */
export const collectAccountRows = async (page: Page): Promise<readonly Locator[] | null> => {
  for (const strategy of ACCOUNT_ROW_STRATEGIES) {
    const visibleRows = strategy(page).filter({ visible: true })
    const appeared = await visibleRows
      .first()
      .waitFor({ state: 'visible', timeout: TARGET_WAIT_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false)
    if (!appeared) {
      continue
    }

    const count = await visibleRows.count()
    return Array.from({ length: count }, (_, index) => visibleRows.nth(index))
  }
  return null
}

/** 行の可視テキストをまとめて取得する（取得できない行は空文字。ログ・例外へは出さない）。 */
export const readRowsText = (rows: readonly Locator[]): Promise<readonly string[]> =>
  Promise.all(rows.map((row) => readLocatorText(row)))

/** クリック前スナップショットの確定を試みる回数と間隔（表示直後の再描画で空テキストになるため）。 */
const ROW_SNAPSHOT_ATTEMPTS = 3
const ROW_SNAPSHOT_RETRY_INTERVAL_MS = 200

/**
 * 空文字の行を含まない有効なスナップショットが得られるまで、短間隔で取得を再試行する。
 * 確定できない場合は null を返す（呼び出し側がクリックせずに停止する。fail closed）。
 */
export const readValidRowsSnapshot = async (
  page: Page,
  rows: readonly Locator[],
): Promise<readonly string[] | null> => {
  for (let attempt = 0; attempt < ROW_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const snapshot = await readRowsText(rows)
    if (isRowSnapshotValid(snapshot)) {
      return snapshot
    }
    if (attempt < ROW_SNAPSHOT_ATTEMPTS - 1) {
      // biome-ignore lint/nursery/noPlaywrightWaitForTimeout: 再試行回数に上限のある取得間隔（最大 2 回）で、行の再描画待ちは条件待ちへ置き換えられない。
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
export type PagePreparation =
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
export const preparePage = async (
  sessionState: SessionState,
  options: { readonly headless: boolean },
): Promise<PagePreparation> => {
  const browser = await chromium.launch({ headless: options.headless })
  try {
    // 破損した storageState で newContext が投げる場合も、セッションの問題として区別して停止する。
    const context = await browser
      .newContext({ storageState: toStorageState(sessionState) })
      .catch(() => null)
    if (context === null) {
      return blocked(browser, 'SESSION_INVALID')
    }

    const page = await context.newPage()
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS)

    // ダイアログは自動で承認しない（fail closed）。出現したら閉じるだけにする。
    page.on('dialog', (dialog) => {
      void dialog.dismiss().catch(() => undefined)
    })

    // 手動更新と同じ導線: 口座一覧ページを開く。
    await page.goto(ME_ACCOUNTS_URL, { waitUntil: 'domcontentloaded' })
    const authAfterLoad = await checkAuthentication(page)
    if (authAfterLoad !== 'OK') {
      return blocked(browser, authAfterLoad)
    }

    // 一括更新コントロールの特定: ページ全体から探す（0 件・複数件は停止）。
    const bulkControl = await resolveTarget(page, BULK_UPDATE_CONTROL_STRATEGIES)
    if (bulkControl.status !== 'RESOLVED') {
      return blocked(browser, bulkControl.status)
    }

    // 更新対象の口座行（「更新」コントロールを含む行）を列挙する。
    const accountRows = await collectAccountRows(page)
    if (accountRows === null) {
      return blocked(browser, 'TARGET_NOT_FOUND')
    }

    return {
      status: 'READY',
      prepared: { browser, page, bulkControl: bulkControl.locator, accountRows },
    }
  } catch (error) {
    await browser.close().catch(() => undefined)
    throw error
  }
}
