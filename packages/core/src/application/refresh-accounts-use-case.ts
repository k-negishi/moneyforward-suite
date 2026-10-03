import type { ApplicationResult } from '../domain/refresh-accounts.js'
import { toApplicationResult, toFailureResult } from '../domain/refresh-accounts.js'
import { createDomainError } from '../errors.js'
import type { LogApplication, LogEvent, LoggerPort, LogJob } from '../ports/logger-port.js'
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
 * 開始時刻からの経過ミリ秒を非負の整数に丸めて返す。
 * 単調時計を使い、ログの durationMs が負の値にならないようにする。
 */
const elapsedMs = (startedAt: number): number =>
  Math.max(0, Math.round(performance.now() - startedAt))

/**
 * 金融機関のデータ一括更新を 1 回だけ実行し、Application Result へ写像する Use Case。
 *
 * 1 回の execute は次の流れで進む。
 *
 * 1. 開始ログを記録する（開始時点では durationMs に意味のある値がないため 0）。
 * 2. セッションを検証する。VALID 以外は一括更新を試行せず fail closed で失敗を返す。
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
    const startedAt = performance.now()
    this.writeLog({ status: 'STARTED', attempt: input.attempt, durationMs: 0 })

    const result = await this.refreshOnce(input.session)

    this.writeLog({
      status: result.status,
      attempt: input.attempt,
      durationMs: elapsedMs(startedAt),
      ...(result.status === 'FAILURE' ? { errorCode: result.errorCode } : {}),
    })

    return result
  }

  /**
   * セッションを検証してから一括更新を 1 回だけ呼ぶ。
   * VALID 以外は一括更新を呼ばずに失敗を返す。認証要求（再ログインというユーザー操作が
   * 要る）だけは AUTH_REQUIRED、判定不能や語彙外れの値は一時障害の可能性を許す
   * TEMPORARY_FAILURE として、いずれも安全側（停止）に倒す。
   * 判定は VALID との比較で行い、検証結果の語彙が増えても停止側へ倒れるようにする。
   */
  private async refreshOnce(session: AuthSession): Promise<ApplicationResult> {
    const verification = await this.moneyForward.verifySession(session)

    if (verification !== 'VALID') {
      return toFailureResult(
        createDomainError(verification === 'AUTH_REQUIRED' ? 'AUTH_REQUIRED' : 'TEMPORARY_FAILURE'),
      )
    }

    const refresh = await this.moneyForward.refreshAccounts(session)

    return refresh.ok ? toApplicationResult(refresh.value) : toFailureResult(refresh.error)
  }

  /** application / job を 1 箇所に固定してログを記録する（呼び出し側からは上書きさせない）。 */
  private writeLog(event: Omit<LogEvent, 'application' | 'job'>): void {
    this.logger.log({ application: LOG_APPLICATION, job: LOG_JOB, ...event })
  }
}
