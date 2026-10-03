import type { SessionState } from '@mf-suite/security'
import { saveSessionState } from '@mf-suite/security'
import type { Page } from 'playwright'
import { chromium } from 'playwright'
import { authStateToLoginStatus, classifyAuthState } from './auth-state.js'
import {
  LOGIN_URL,
  ME_ACCOUNTS_URL,
  ME_HOME_URL,
  NAVIGATION_TIMEOUT_MS,
  REFRESH_POLL_INTERVAL_MS,
  ROW_CHANGE_TIMEOUT_MS,
  TARGET_WAIT_TIMEOUT_MS,
} from './locators.js'
import type { RefreshBlocked } from './page-helpers.js'
import {
  checkAuthentication,
  collectAccountRows,
  collectAuthStateSignals,
  preparePage,
  readRowsText,
  readValidRowsSnapshot,
  toSessionState,
  toStorageState,
} from './page-helpers.js'
import type { RowChangeEvidence } from './row-changes.js'
import { detectRowChanges } from './row-changes.js'

// セッション形式の相互変換と停止理由の語彙は、ページ操作の公開面としてこのモジュールからも参照できるようにする。
export type { RefreshBlocked }
export { toSessionState, toStorageState }

/**
 * Playwright による MoneyForward ME のページ操作（公開 API）。
 * 手動更新と同じ導線（口座一覧ページの一括更新コントロール）を使う。
 * 実機では一括更新は行ごとに処理され、メッセージ・ページ遷移は無く、行のスピナー表示と
 * 更新日時の変化で確認できる。そのためクリック前後の行テキストを比較し、変化または
 * 進行中シグナルの新規出現で受付を判定する（ADR-0020）。
 * ・URL / Selector / 操作を引数で受け付けない（ADR-0010）
 * ・戻り値は状態識別子・件数・真偽値のみ（金額・カード番号・Cookie・セッション・URL・行テキストは返さない）
 * ・Screenshot / HTML dump / HAR / Trace / Video を保存しない（ADR-0017）
 * ページ操作の下位処理（セッション変換・認証確認・Locator 探索・ページ準備）は page-helpers に置く。
 */

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
    if (context === null) {
      return 'UNKNOWN'
    }

    const page = await context.newPage()
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS)

    await page.goto(ME_ACCOUNTS_URL, { waitUntil: 'domcontentloaded' })
    const authCheck = await checkAuthentication(page)
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
  options: { readonly headless: boolean },
): Promise<RefreshTargetsOutcome> => {
  const preparation = await preparePage(sessionState, options)
  if (preparation.status !== 'READY') {
    return { status: preparation.reason }
  }

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

    if (Date.now() >= deadline) {
      return toObservation(beforeRows.length, lastEvidence)
    }
    // biome-ignore lint/nursery/noPlaywrightWaitForTimeout: deadline 付きポーリングの待機間隔（打ち切りは上の deadline 判定で行う）。
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
  if (preparation.status !== 'READY') {
    return { status: preparation.reason }
  }

  const { browser, page, bulkControl, accountRows } = preparation.prepared
  try {
    // クリック前の比較基準を有効な観測として確定する。確定できない場合はクリックしない
    // （無効な基準では受付を確認できず、長いタイムアウトを空費するため）。
    const rowsBefore = await readValidRowsSnapshot(page, accountRows)
    if (rowsBefore === null) {
      return { status: 'TEMPORARY_FAILURE' }
    }

    // 金融機関のデータ一括更新を実行する。
    // クリックには明示タイムアウトを付ける（要素の消滅等で既定の長い待機に引きずられない）。
    const clicked = await bulkControl
      .click({ timeout: TARGET_WAIT_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false)
    // クリックできなければ状態変化を確認できないため、受付としない（fail closed）。
    if (!clicked) {
      return { status: 'TEMPORARY_FAILURE' }
    }

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
    if (authAfterClick === 'TEMPORARY_FAILURE') {
      return { status: 'TEMPORARY_FAILURE' }
    }

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
    if (!completed) {
      return { status: 'NOT_COMPLETED' }
    }

    // ログイン状態を三値で判定し、結果へ写す。未認証は AUTH_REQUIRED、
    // 判定不能（本文取得失敗）は TEMPORARY_FAILURE として、いずれも保存しない（fail closed）。
    await page.goto(ME_HOME_URL, { waitUntil: 'domcontentloaded' })
    const loginStatus = authStateToLoginStatus(
      classifyAuthState(await collectAuthStateSignals(page)),
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
