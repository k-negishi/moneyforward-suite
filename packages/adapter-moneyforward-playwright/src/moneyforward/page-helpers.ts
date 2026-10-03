import type { SessionState } from '@mf-suite/security'
import type { BrowserContext, Locator, Page } from 'playwright'

import type { AuthStateSignals } from './auth-state.js'
import { classifyAuthState } from './auth-state.js'
import type { LocatorRoot, LocatorStrategy, RefreshTimeouts } from './locators.js'
import {
  ACCOUNT_ROW_STRATEGIES,
  AUTH_CHALLENGE_INPUT_SELECTOR,
  BULK_UPDATE_CONTROL_STRATEGIES,
  isSignInUrl,
} from './locators.js'
import { isRowSnapshotValid } from './row-changes.js'

/**
 * ページ操作の下位ヘルパー。セッション状態の相互変換、認証確認、Locator 探索、
 * 開いたページの準備（認証・対象の特定）を担う。
 * 公開 API（セッション検証・更新可否の確認・一括更新の実行・手動ログイン）は page-client に置き、
 * 依存は page-client → page-helpers の一方向に保つ（受付の観測は page-client 側にある）。
 * ・URL / Selector / 操作を引数で受け付けない（ADR-0010）
 * ・戻り値は状態識別子・件数・真偽値のみ（金額・カード番号・Cookie・セッション・URL・行テキストは返さない）
 * ・Screenshot / HTML dump / HAR / Trace / Video を保存しない（ADR-0017）
 * ・タイムアウトは注入された値だけを使い、テストは実時間を待たずに短縮する
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

/** Locator 探索の結果。 */
export type Resolution =
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
  timeouts: RefreshTimeouts,
): Promise<Resolution> => {
  for (const strategy of strategies) {
    const visibleMatches = strategy(root).filter({ visible: true })
    const appeared = await visibleMatches
      .first()
      .waitFor({ state: 'visible', timeout: timeouts.targetWaitMs })
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
const readLocatorText = async (locator: Locator, timeouts: RefreshTimeouts): Promise<string> => {
  try {
    return await locator.innerText({ timeout: timeouts.targetWaitMs })
  } catch {
    return ''
  }
}

/** ページ全体の可視テキストを取得する（認証チャレンジ文言の探索用。取得できなければ空文字）。 */
const readVisibleText = (page: Page, timeouts: RefreshTimeouts): Promise<string> =>
  readLocatorText(page.locator('body'), timeouts)

/**
 * 認証状態の観測値をページから集める（分類は auth-state.ts の純関数が行う）。
 * 入力欄は可視のものだけを数える（非表示のテンプレートや過去のフォームを拾わない）。
 */
export const collectAuthStateSignals = async (
  page: Page,
  timeouts: RefreshTimeouts,
): Promise<AuthStateSignals> => ({
  isSignInUrl: isSignInUrl(page.url()),
  visibleText: await readVisibleText(page, timeouts),
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
  timeouts: RefreshTimeouts,
): Promise<'OK' | 'AUTH_REQUIRED' | 'TEMPORARY_FAILURE'> => {
  const authState = classifyAuthState(await collectAuthStateSignals(page, timeouts))
  if (authState === 'AUTHENTICATED') {
    return 'OK'
  }
  return authState === 'UNKNOWN' ? 'TEMPORARY_FAILURE' : 'AUTH_REQUIRED'
}

/**
 * 一括更新コントロールをページ全体から特定する（読み取りのみ）。
 * 0 件（TARGET_NOT_FOUND）・複数件（TARGET_AMBIGUOUS）は停止する（fail closed）。
 */
export const resolveBulkUpdateControl = (
  page: Page,
  timeouts: RefreshTimeouts,
): Promise<Resolution> => resolveTarget(page, BULK_UPDATE_CONTROL_STRATEGIES, timeouts)

/**
 * 更新対象の口座行（「更新」コントロールを含む行）を可視のものだけ列挙する。
 * 複数一致が正常（対象の口座が複数ある）のため、resolveTarget とは別に扱う。
 * どの戦略でも見つからない場合は null を返す（呼び出し側が停止する。fail closed）。
 */
export const collectAccountRows = async (
  page: Page,
  timeouts: RefreshTimeouts,
): Promise<readonly Locator[] | null> => {
  for (const strategy of ACCOUNT_ROW_STRATEGIES) {
    const visibleRows = strategy(page).filter({ visible: true })
    const appeared = await visibleRows
      .first()
      .waitFor({ state: 'visible', timeout: timeouts.targetWaitMs })
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
export const readRowsText = (
  rows: readonly Locator[],
  timeouts: RefreshTimeouts,
): Promise<readonly string[]> => Promise.all(rows.map((row) => readLocatorText(row, timeouts)))

/** スナップショット確定を試みる回数（表示直後の再描画で空テキストになるため、短間隔で再試行する）。 */
const ROW_SNAPSHOT_ATTEMPTS = 3

/**
 * 空文字の行を含まない有効なスナップショットが得られるまで、短間隔で取得を再試行する。
 * 確定できない場合は null を返す（呼び出し側がクリックせずに停止する。fail closed）。
 */
const readValidRowsSnapshot = async (
  page: Page,
  rows: readonly Locator[],
  timeouts: RefreshTimeouts,
): Promise<readonly string[] | null> => {
  for (let attempt = 0; attempt < ROW_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const snapshot = await readRowsText(rows, timeouts)
    if (isRowSnapshotValid(snapshot)) {
      return snapshot
    }
    if (attempt < ROW_SNAPSHOT_ATTEMPTS - 1) {
      // biome-ignore lint/nursery/noPlaywrightWaitForTimeout: 再試行回数に上限のある取得間隔（最大 2 回）で、行の再描画待ちは条件待ちへ置き換えられない。
      await page.waitForTimeout(timeouts.snapshotIntervalMs)
    }
  }
  return null
}

/**
 * クリック前の比較基準を作る。スナップショットを 2 回（間隔を空けて）観測し、
 * 両方で一致した行だけを残す。一致しなかった行は null（不安定な行）とし、
 * 比較の基準に使わない（自然変動する行をクリックへの反応と誤認しないため）。
 * 有効な観測が得られない場合と、全行が不安定な場合は null を返し、呼び出し側は
 * クリックせずに停止する（fail closed。無効な基準では受付を判定できない）。
 */
export const readStableRowsSnapshot = async (
  page: Page,
  rows: readonly Locator[],
  timeouts: RefreshTimeouts,
): Promise<readonly (string | null)[] | null> => {
  const first = await readValidRowsSnapshot(page, rows, timeouts)
  if (first === null) {
    return null
  }

  // biome-ignore lint/nursery/noPlaywrightWaitForTimeout: 2 回観測の間隔（回数固定）。自然変動する行の検出には、行の再描画待ちではなく時間を空けた再観測が必要。
  await page.waitForTimeout(timeouts.snapshotIntervalMs)

  const second = await readValidRowsSnapshot(page, rows, timeouts)
  if (second === null) {
    return null
  }

  const stable = first.map((row, index) => (row === second[index] ? row : null))
  return stable.every((row) => row === null) ? null : stable
}

/** 操作の準備が整った口座一覧ページ。Browser の close は呼び出し側が finally で行う。 */
export interface PreparedAccountsPage {
  readonly page: Page
  readonly bulkControl: Locator
  readonly accountRows: readonly Locator[]
}

/** ページの準備結果。BLOCKED の場合は理由を返す（Browser の close は呼び出し側の責務）。 */
export type PagePreparation =
  | { readonly status: 'READY'; readonly prepared: PreparedAccountsPage }
  | { readonly status: 'BLOCKED'; readonly reason: RefreshBlocked }

/**
 * 開いた口座一覧ページで認証確認と対象（一括更新コントロール・口座行）の特定を行う。
 * 続行できない場合は理由を返す（BLOCKED）。Browser は閉じない（呼び出し側が finally で閉じる）。
 */
export const prepareAccountsPage = async (
  page: Page,
  timeouts: RefreshTimeouts,
): Promise<PagePreparation> => {
  const authAfterLoad = await checkAuthentication(page, timeouts)
  if (authAfterLoad !== 'OK') {
    return { status: 'BLOCKED', reason: authAfterLoad }
  }

  // 一括更新コントロールの特定: ページ全体から探す（0 件・複数件は停止）。
  const bulkControl = await resolveBulkUpdateControl(page, timeouts)
  if (bulkControl.status !== 'RESOLVED') {
    return { status: 'BLOCKED', reason: bulkControl.status }
  }

  // 更新対象の口座行（「更新」コントロールを含む行）を列挙する。
  const accountRows = await collectAccountRows(page, timeouts)
  if (accountRows === null) {
    return { status: 'BLOCKED', reason: 'TARGET_NOT_FOUND' }
  }

  return { status: 'READY', prepared: { page, bulkControl: bulkControl.locator, accountRows } }
}
