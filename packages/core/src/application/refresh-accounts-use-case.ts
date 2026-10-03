import { createDomainError } from '../errors.js'
import { toApplicationResult, toFailureResult } from '../domain/refresh-accounts.js'
import type { ApplicationResult } from '../domain/refresh-accounts.js'
import type { LogApplication, LogEvent, LogJob, LoggerPort } from '../ports/logger-port.js'
import type { AuthSession, MoneyForwardPort } from '../ports/money-forward-port.js'

/**
 * 一括更新 Use Case の入力。
 * attempt は実行基盤が採番する試行番号で、Use Case は再試行を制御せず、
 * 受け取った値をログへ写すだけにする（待機・回数上限は実行基盤の責務）。
 */
export interface RefreshAccountsInput {
  readonly session: AuthSession
  readonly attempt: number
}

/** 一括更新 Use Case の依存。Port のみを受け取り、Concrete Adapter は生成・import しない。 */
export interface RefreshAccountsUseCaseDependencies {
  readonly moneyForward: MoneyForwardPort
  readonly logger: LoggerPort
}

/** この Use Case が記録するログの Allow List 値。 */
const LOG_APPLICATION: LogApplication = 'automation'
const LOG_JOB: LogJob = 'refresh-accounts'

/**
 * 金融機関のデータ一括更新を 1 回だけ実行し、Application Result へ写像する Use Case。
 *
 * 1 回の execute は次の流れで進む。
 *
 * 1. 開始ログを記録する（開始時点では durationMs に意味のある値がないため 0）。
 * 2. セッションを検証する。認証要求・判定不能なら一括更新を試行せず fail closed で失敗を返す。
 * 3. 一括更新を 1 回だけ呼び、受付・結果を Application Result へ写像する。
 * 4. 実行時間を計測し、完了ログを 1 回だけ記録する（失敗時は errorCode を付ける）。
 *
 * 再試行・待機は行わない（実行基盤の責務）。失敗の Application Result は正準の写像
 * （toFailureResult）だけから組み立て、status と errorCode の対応を 1 箇所に固定する。
 */
export class RefreshAccountsUseCase {
  private readonly moneyForward: MoneyForwardPort
  private readonly logger: LoggerPort

  constructor(dependencies: RefreshAccountsUseCaseDependencies) {
    this.moneyForward = dependencies.moneyForward
    this.logger = dependencies.logger
  }

  /** 1 回の試行を実行する。再試行の判断・待機は呼び出し側（実行基盤）が行う。 */
  async execute(input: RefreshAccountsInput): Promise<ApplicationResult> {
    const startedAt = Date.now()
    this.writeLog({ status: 'STARTED', attempt: input.attempt, durationMs: 0 })

    const result = await this.refreshOnce(input.session)

    this.writeLog({
      status: result.status,
      attempt: input.attempt,
      durationMs: Date.now() - startedAt,
      ...(result.status === 'FAILURE' ? { errorCode: result.errorCode } : {}),
    })

    return result
  }

  /**
   * セッションを検証してから一括更新を 1 回だけ呼ぶ。
   * 検証が VALID でなければ一括更新は呼ばない。認証要求（再ログインというユーザー操作が
   * 要る）は再試行しても回復しないため AUTH_REQUIRED、判定不能は一時障害の可能性を
   * 許すため TEMPORARY_FAILURE として、いずれも安全側（停止）に倒す。
   */
  private async refreshOnce(session: AuthSession): Promise<ApplicationResult> {
    const verification = await this.moneyForward.verifySession(session)

    if (verification === 'AUTH_REQUIRED') {
      return toFailureResult(createDomainError('AUTH_REQUIRED'))
    }

    if (verification === 'UNKNOWN') {
      return toFailureResult(createDomainError('TEMPORARY_FAILURE'))
    }

    const refresh = await this.moneyForward.refreshAccounts(session)

    return refresh.ok ? toApplicationResult(refresh.value) : toFailureResult(refresh.error)
  }

  /** application / job を 1 箇所に固定してログを記録する（呼び出し側からは上書きさせない）。 */
  private writeLog(event: Omit<LogEvent, 'application' | 'job'>): void {
    this.logger.log({ application: LOG_APPLICATION, job: LOG_JOB, ...event })
  }
}
