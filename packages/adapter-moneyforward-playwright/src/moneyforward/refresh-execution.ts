import type { Page } from 'playwright'

import type { RefreshTimeouts } from './locators.js'
import type { PreparedAccountsPage, RefreshBlocked } from './page-helpers.js'
import {
  checkAuthentication,
  collectAccountRows,
  readRowsText,
  readStableRowsSnapshot,
} from './page-helpers.js'
import type { RowChangeEvidence } from './row-changes.js'
import { detectRowChanges } from './row-changes.js'

/**
 * 一括更新の実行と受付の観測。クリックの成否では判定せず、行の変化という状態変化で
 * 判定する（ADR-0020）。受付は正の証拠（絶対日時の変化・進行中シグナルの新規出現）だけで
 * 判定し、失敗は件数として独立に観測へ載せる（一部成功・一部失敗の総合的な判定は core の
 * 写像が行う）。観測中も数回に 1 回セッション失効を確認し、失効を検知したら認証要求として
 * 早期に返す。ページ操作の下位処理は page-helpers に置き、依存は page-client →
 * refresh-execution → page-helpers の一方向に保つ（Browser の close は呼び出し側が finally で行う）。
 * ・戻り値は状態識別子・件数・真偽値のみ（行テキスト・URL・Cookie は返さない）
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

/** 一括更新の実行結果。OBSERVED は受付の確認まで進んだことを表す。 */
export type RefreshExecutionOutcome =
  | { readonly status: 'OBSERVED'; readonly observation: RefreshObservation }
  | { readonly status: RefreshBlocked }

/** 行変化の証拠を、受付の観測結果へ写す（件数と真偽値のみ。行テキストは含めない）。 */
const toObservation = (
  observedRowCount: number,
  evidence: RowChangeEvidence,
): RefreshObservation => {
  // 受付は正の証拠（変化した行・進行中シグナルの新規出現）だけで判定し、失敗の有無で潰さない
  // （一部成功・一部失敗の観測を core の写像へ渡し、部分成功として扱わせる）。
  const accepted = evidence.changedCount > 0 || evidence.inProgressAppeared
  return {
    acceptance: accepted ? 'ACCEPTED' : 'NOT_ACCEPTED',
    observedRowCount,
    changedRowCount: evidence.changedCount,
    failedRowCount: evidence.failedCount,
    inProgressAppeared: evidence.inProgressAppeared,
    authLost: false,
  }
}

/** 認証が失われたときの観測（受付の有無によらず、呼び出し側が認証要求として扱う。fail closed）。 */
const authLostObservation = (observedRowCount: number): RefreshObservation => ({
  acceptance: 'NOT_ACCEPTED',
  observedRowCount,
  changedRowCount: 0,
  failedRowCount: 0,
  inProgressAppeared: false,
  authLost: true,
})

/** 観測中にセッション失効を確認する間隔（ポーリング回数）。毎回の確認は観測を遅くするため間引く。 */
const AUTH_RECHECK_POLL_INTERVAL = 5

/**
 * 一括更新のクリック後、行の変化（受付）を確認できるまで観測を繰り返す。
 * 進行中シグナルの新規出現、または絶対日時の変化で受理とする。失敗の出現では打ち切らない
 * （他の行の変化が遅れて現れる場合に、部分成功を拒否へ潰さないため。失敗は行数として観測に
 * 載せ、受付の有無と合わせた判定は core の写像が行う）。受付の正の証拠が出るか、観測期限まで待つ。
 * 空文字の行を含む観測や行数が一致しない観測（再描画・デタッチ中・行の増減）は無効として
 * 使わず、次のポーリングへ進む。
 * 観測中も数回に 1 回セッション失効を確認し、失効を検知したら受付の有無によらず authLost の
 * 観測として早期に返す（呼び出し側が認証要求として扱う）。
 */
const waitForAcceptance = async (
  page: Page,
  beforeRows: readonly (string | null)[],
  timeouts: RefreshTimeouts,
): Promise<RefreshObservation> => {
  const deadline = Date.now() + timeouts.rowChangeMs
  let lastEvidence: RowChangeEvidence = {
    valid: false,
    changedCount: 0,
    inProgressAppeared: false,
    failedCount: 0,
  }
  let pollCount = 0

  for (;;) {
    // 数回に 1 回、セッション失効を確認する（クリック直後の確認は executeRefreshOnAccountsPage が
    // 行っているため、最初のポーリングでは省く）。判定不能（TEMPORARY_FAILURE）は再描画中の
    // 一時状態であり得るため、失効（AUTH_REQUIRED）だけを確定として扱う。
    if (pollCount > 0 && pollCount % AUTH_RECHECK_POLL_INTERVAL === 0) {
      const authCheck = await checkAuthentication(page, timeouts)
      if (authCheck === 'AUTH_REQUIRED') {
        return { ...toObservation(beforeRows.length, lastEvidence), authLost: true }
      }
    }

    const rows = await collectAccountRows(page, timeouts)
    if (rows !== null) {
      const rowsAfter = await readRowsText(rows, timeouts)
      const evidence = detectRowChanges(beforeRows, rowsAfter)
      if (evidence.valid) {
        lastEvidence = evidence
        if (evidence.changedCount > 0 || evidence.inProgressAppeared) {
          return toObservation(beforeRows.length, evidence)
        }
      }
    }

    if (Date.now() >= deadline) {
      return toObservation(beforeRows.length, lastEvidence)
    }
    // biome-ignore lint/nursery/noPlaywrightWaitForTimeout: deadline 付きポーリングの待機間隔（打ち切りは上の deadline 判定で行う）。
    await page.waitForTimeout(timeouts.pollIntervalMs)
    pollCount += 1
  }
}

/**
 * 準備済みの口座一覧ページで、金融機関のデータ一括更新を実行し、行ごとの受付を観測する。
 * クリックの成否では判定せず、行の変化という状態変化で判定する（ADR-0020）。
 * 受付を確認できない場合・失敗を検知した場合は OBSERVED（NOT_ACCEPTED）として返し、
 * 操作を続行できない場合は理由（RefreshBlocked）を返す。呼び出し側が Result へ写す。
 * Browser は閉じない（呼び出し側が finally で閉じる）。
 */
export const executeRefreshOnAccountsPage = async (
  prepared: PreparedAccountsPage,
  timeouts: RefreshTimeouts,
): Promise<RefreshExecutionOutcome> => {
  const { page, bulkControl, accountRows } = prepared

  // クリック前の比較基準を 2 回観測で確定する。確定できない場合はクリックしない
  // （不安定な基準では受付を確認できず、長時間の観測を空費するため。fail closed）。
  const rowsBefore = await readStableRowsSnapshot(page, accountRows, timeouts)
  if (rowsBefore === null) {
    return { status: 'TEMPORARY_FAILURE' }
  }

  // 金融機関のデータ一括更新を実行する。
  // クリックには明示タイムアウトを付ける（要素の消滅等で既定の長い待機に引きずられない）。
  const clicked = await bulkControl
    .click({ timeout: timeouts.targetWaitMs })
    .then(() => true)
    .catch(() => false)
  // クリックできなければ状態変化を確認できないため、受付としない（fail closed）。
  if (!clicked) {
    return { status: 'TEMPORARY_FAILURE' }
  }

  // クリック後にセッションが失効していないか確認する（失効時は再ログインが必要なため停止する）。
  const authAfterClick = await checkAuthentication(page, timeouts)
  if (authAfterClick === 'AUTH_REQUIRED') {
    return { status: 'OBSERVED', observation: authLostObservation(rowsBefore.length) }
  }
  if (authAfterClick === 'TEMPORARY_FAILURE') {
    return { status: 'TEMPORARY_FAILURE' }
  }

  // 行の変化（受付）が確認できれば受理。受付の正の証拠が無ければ不受理として観測を返す。
  return { status: 'OBSERVED', observation: await waitForAcceptance(page, rowsBefore, timeouts) }
}
