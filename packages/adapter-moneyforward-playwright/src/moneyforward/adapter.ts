import { createDomainError } from '@mf-suite/core'
import type {
  AuthSession,
  MoneyForwardPort,
  RefreshAccountsOutcome,
  Result,
  SessionVerification,
} from '@mf-suite/core'
import { fromAuthSession } from '@mf-suite/security'

import { checkSession, executeRefresh } from './page-client.js'
import type { RefreshExecutionOutcome, RefreshObservation } from './page-client.js'

/**
 * MoneyForwardPort（core が定義）の Playwright 実装。
 * ページ操作の結果を core の語彙（Result / SessionVerification / RefreshAccountsOutcome）へ写す。
 * 例外はこの境界で捕捉し、Result（または三値）へ変換して返す。例外の内容は外へ出さない
 * （URL・DOM・Cookie を含み得るため）。ログは自身では出力しない（LoggerPort の結線は
 * Composition Root の責務）。
 */

/** Adapter の動作オプション。 */
export interface PlaywrightMoneyForwardAdapterOptions {
  /** ブラウザを表示するか（読み取り・検証は headless を既定にする）。 */
  readonly headless: boolean
}

/** 観測結果を core の観測型へ写す（件数と真偽値のみ。行テキスト・URL・Cookie は載せない）。 */
const toOutcome = (observation: RefreshObservation): RefreshAccountsOutcome => ({
  acceptance: observation.acceptance,
  evidence: {
    observedRowCount: observation.observedRowCount,
    changedRowCount: observation.changedRowCount,
    failedRowCount: observation.failedRowCount,
    inProgressAppeared: observation.inProgressAppeared,
  },
  authLost: observation.authLost,
})

/**
 * ページ操作の結果を Port の契約（Result<RefreshAccountsOutcome>）へ写像する（純関数）。
 * 操作を続行できなかった場合は Result.error（分類は core の ErrorCode と同じ語彙）、
 * 受付の確認まで進んだ場合は ok の観測結果を返す（受付の判定は core の写像が行う）。
 */
export const toRefreshResult = (
  outcome: RefreshExecutionOutcome,
): Result<RefreshAccountsOutcome> => {
  if (outcome.status !== 'OBSERVED') {
    return { ok: false, error: createDomainError(outcome.status) }
  }
  return { ok: true, value: toOutcome(outcome.observation) }
}

/**
 * MoneyForwardPort の Playwright 実装。
 * セッションの消費（opaque な AuthSession からブラウザへ適用できる形への変換）は
 * security の変換関数を通して行う。
 */
export class PlaywrightMoneyForwardAdapter implements MoneyForwardPort {
  private readonly options: PlaywrightMoneyForwardAdapterOptions

  constructor(options: PlaywrightMoneyForwardAdapterOptions) {
    this.options = options
  }

  /** セッションの有効性を検証する。判定できない場合は UNKNOWN（呼び出し側が fail closed で停止する）。 */
  async verifySession(session: AuthSession): Promise<SessionVerification> {
    try {
      return await checkSession(fromAuthSession(session), this.options)
    } catch {
      // 例外の内容は出さない（URL・DOM が混ざり得るため）。判定不能として停止側に倒す。
      return 'UNKNOWN'
    }
  }

  /**
   * 金融機関のデータ一括更新を実行し、受付・結果の観測値を返す。
   * 起動・遷移の例外は一時障害として Result へ写す（再試行可否は core の対応表が決める）。
   */
  async refreshAccounts(session: AuthSession): Promise<Result<RefreshAccountsOutcome>> {
    try {
      return toRefreshResult(await executeRefresh(fromAuthSession(session), this.options))
    } catch {
      return { ok: false, error: createDomainError('TEMPORARY_FAILURE') }
    }
  }
}
