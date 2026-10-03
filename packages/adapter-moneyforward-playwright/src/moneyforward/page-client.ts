import type { SessionState } from '@mf-suite/security'
import { saveSessionState } from '@mf-suite/security'
import type { Browser, BrowserContextOptions, LaunchOptions, Page } from 'playwright'
import { chromium } from 'playwright'

import { authStateToLoginStatus, classifyAuthState } from './auth-state.js'
import type { RefreshTimeouts } from './locators.js'
import { LOGIN_URL, ME_ACCOUNTS_URL, ME_HOME_URL, resolveTimeouts } from './locators.js'
import type { RefreshBlocked } from './page-helpers.js'
import {
  checkAuthentication,
  collectAuthStateSignals,
  prepareAccountsPage,
  toSessionState,
  toStorageState,
} from './page-helpers.js'
import type { RefreshExecutionOutcome, RefreshObservation } from './refresh-execution.js'
import { executeRefreshOnAccountsPage } from './refresh-execution.js'

// セッション形式の相互変換・停止理由の語彙・観測の型は、ページ操作の公開面として
// このモジュールからも参照できるようにする。
export type { RefreshBlocked, RefreshExecutionOutcome, RefreshObservation }
export { toSessionState, toStorageState }

/**
 * Playwright による MoneyForward ME のページ操作（公開 API）。
 * 手動更新と同じ導線（口座一覧ページの一括更新コントロール）を使う。
 * 受付の観測は refresh-execution に置き、失敗は件数として独立に数え、受付の有無は正の証拠だけで
 * 判定する（一部成功・一部失敗の総合的な判定は core の写像が行う）。クリック前は 2 回観測して
 * 一致した行だけを比較の基準にし、観測中も数回に 1 回セッション失効を確認する。
 * ・URL / Selector / 操作を引数で受け付けない（ADR-0010）
 * ・戻り値は状態識別子・件数・真偽値のみ（金額・カード番号・Cookie・セッション・URL・行テキストは返さない）
 * ・Screenshot / HTML dump / HAR / Trace / Video を保存しない（ADR-0017）。起動・Context の
 *   オプションは builder（buildLaunchOptions / buildContextOptions）だけが生成し、
 *   記録系のキーを持たないことを単体テストで固定する
 * ・Browser は成功・失敗にかかわらず全経路で close する（try/finally）
 * ・タイムアウトは注入でき、テストは実時間を待たずに短縮する
 * ページ操作の下位処理（セッション変換・認証確認・Locator 探索・ページ準備）は page-helpers に置く。
 */

/** ページ操作の動作オプション。タイムアウトは部分指定で上書きできる。 */
export interface PageClientOptions {
  /** ブラウザを表示するか（読み取り・検証は headless を既定にする）。 */
  readonly headless: boolean
  /** タイムアウトの部分上書き（テストが実時間を待たずに短縮するために使う）。 */
  readonly timeouts?: Partial<RefreshTimeouts>
}

/**
 * chromium.launch のオプションを生成する（純関数）。
 * 記録系（trace / video / screenshot 等）のキーを持たない（恒常保存物を作らない。ADR-0017）。
 * launch を呼ぶ全経路がこの builder を経由することで、キーの混入を単体テストで固定できる。
 */
export const buildLaunchOptions = (options: { readonly headless: boolean }): LaunchOptions => ({
  headless: options.headless,
})

/**
 * BrowserContext のオプションを生成する（純関数）。
 * セッションが渡された場合だけ storageState を設定する。記録系（recordHar / recordVideo /
 * trace 等）のキーは持たない（ADR-0017）。手動ログインのように新しいセッションを作る経路は
 * 引数なしで呼ぶ。
 */
export const buildContextOptions = (sessionState?: SessionState): BrowserContextOptions =>
  sessionState === undefined ? {} : { storageState: toStorageState(sessionState) }

/** 更新可否の確認（読み取りのみ）の結果。 */
export type RefreshTargetsOutcome =
  | { readonly status: 'AVAILABLE' }
  | { readonly status: RefreshBlocked }

/** 手動ログインのセッション確立の結果。NOT_COMPLETED はユーザー操作の未完了（EOF 等）を表す。 */
export type LoginSessionResult =
  | { readonly status: 'SESSION_SAVED' }
  | { readonly status: 'NOT_COMPLETED' }
  | { readonly status: 'AUTH_REQUIRED' }
  | { readonly status: 'TEMPORARY_FAILURE' }

/**
 * ブラウザを起動し、口座一覧ページを開く。セッションを適用できない場合（storageState の
 * 破損等）は null を返し、呼び出し側が SESSION_INVALID として停止する。
 * 起動・遷移の例外はそのまま投げる（呼び出し側が Result へ写す。Browser の close は呼び出し側の finally）。
 */
const openAccountsPage = async (
  browser: Browser,
  sessionState: SessionState,
  timeouts: RefreshTimeouts,
): Promise<Page | null> => {
  // 破損した storageState で newContext が投げる場合も、セッションの問題として区別して停止する。
  const context = await browser.newContext(buildContextOptions(sessionState)).catch(() => null)
  if (context === null) {
    return null
  }

  const page = await context.newPage()
  page.setDefaultNavigationTimeout(timeouts.navigationMs)

  // ダイアログは自動で承認しない（fail closed）。出現したら閉じるだけにする。
  page.on('dialog', (dialog) => {
    void dialog.dismiss().catch(() => undefined)
  })

  // 手動更新と同じ導線: 口座一覧ページを開く。
  await page.goto(ME_ACCOUNTS_URL, { waitUntil: 'domcontentloaded' })
  return page
}

/**
 * セッションの有効性を検証する（口座一覧ページを開いて認証状態を確認する）。
 * 認証済みなら VALID、未認証（リダイレクト・認証チャレンジ）は AUTH_REQUIRED。
 * セッションを適用できない・本文を取得できない場合は UNKNOWN（判定不能。呼び出し側が fail closed で扱う）。
 */
export const checkSession = async (
  sessionState: SessionState,
  options: PageClientOptions,
): Promise<'VALID' | 'AUTH_REQUIRED' | 'UNKNOWN'> => {
  const timeouts = resolveTimeouts(options.timeouts)
  const browser = await chromium.launch(buildLaunchOptions(options))
  try {
    const page = await openAccountsPage(browser, sessionState, timeouts)
    if (page === null) {
      return 'UNKNOWN'
    }

    const authCheck = await checkAuthentication(page, timeouts)
    if (authCheck === 'OK') {
      return 'VALID'
    }
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
  options: PageClientOptions,
): Promise<RefreshTargetsOutcome> => {
  const timeouts = resolveTimeouts(options.timeouts)
  const browser = await chromium.launch(buildLaunchOptions(options))
  try {
    const page = await openAccountsPage(browser, sessionState, timeouts)
    if (page === null) {
      return { status: 'SESSION_INVALID' }
    }

    const preparation = await prepareAccountsPage(page, timeouts)
    if (preparation.status !== 'READY') {
      return { status: preparation.reason }
    }
    return { status: 'AVAILABLE' }
  } finally {
    await browser.close()
  }
}

/**
 * 金融機関のデータ一括更新を実行し、行ごとの受付を観測する。
 * クリックの成否では判定せず、行の変化という状態変化で判定する（ADR-0020）。
 * 受付を確認できない場合は OBSERVED（NOT_ACCEPTED）として返し、
 * 操作を続行できない場合は理由（RefreshBlocked）を返す。呼び出し側が Result へ写す。
 * 起動・遷移・観測の例外はそのまま投げる（呼び出し側が Result へ写す）。
 * Browser は成功・失敗にかかわらず finally で閉じる。
 */
export const executeRefresh = async (
  sessionState: SessionState,
  options: PageClientOptions,
): Promise<RefreshExecutionOutcome> => {
  const timeouts = resolveTimeouts(options.timeouts)
  const browser = await chromium.launch(buildLaunchOptions(options))
  try {
    const page = await openAccountsPage(browser, sessionState, timeouts)
    if (page === null) {
      return { status: 'SESSION_INVALID' }
    }

    const preparation = await prepareAccountsPage(page, timeouts)
    if (preparation.status !== 'READY') {
      return { status: preparation.reason }
    }

    return await executeRefreshOnAccountsPage(preparation.prepared, timeouts)
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
  const timeouts = resolveTimeouts()
  const browser = await chromium.launch(buildLaunchOptions({ headless: false }))
  try {
    const context = await browser.newContext(buildContextOptions())
    const page = await context.newPage()
    page.setDefaultNavigationTimeout(timeouts.navigationMs)

    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' })

    const completed = await waitForLogin()
    if (!completed) {
      return { status: 'NOT_COMPLETED' }
    }

    // ログイン状態を三値で判定し、結果へ写す。未認証は AUTH_REQUIRED、
    // 判定不能（本文取得失敗）は TEMPORARY_FAILURE として、いずれも保存しない（fail closed）。
    await page.goto(ME_HOME_URL, { waitUntil: 'domcontentloaded' })
    const loginStatus = authStateToLoginStatus(
      classifyAuthState(await collectAuthStateSignals(page, timeouts)),
    )
    if (loginStatus !== 'SESSION_SAVED') {
      return { status: loginStatus }
    }

    saveSessionState(sessionFilePath, toSessionState(await context.storageState()))
    return { status: 'SESSION_SAVED' }
  } finally {
    // 成功・失敗のどちらでもブラウザを閉じる。
    await browser.close()
  }
}
