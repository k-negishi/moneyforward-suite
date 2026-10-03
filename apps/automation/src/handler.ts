import type { ApplicationResult, RefreshAccountsInput } from '@mf-suite/core'
import { createDomainError, toFailureResult } from '@mf-suite/core'
import type { JobName } from './job-router.js'
import { routeJob } from './job-router.js'
import type { SessionProvider } from './session-provider.js'

/**
 * Automation Handler（薄い Driving Adapter）。
 * 入力の検証と Job の選択（Job Router）→ セッション取得 → Use Case の実行 → 結果の写像だけを行い、
 * 業務判断（status / errorCode の決定）は Use Case の結果をそのまま写して再実装しない。
 * 出力は status と errorCode だけの契約とし、Secret・Cookie・金融情報を構造として含めない。
 */

/** Handler が呼ぶ Input Port。Use Case（RefreshAccountsUseCase）をテストでは fake に差し替える。 */
export interface RefreshAccountsExecutor {
  execute(input: RefreshAccountsInput): Promise<ApplicationResult>
}

/**
 * Job 名 → 実行担当の対応表。Record 型で網羅を型検査に強制し、JobName へ値を追加したときの
 * 対応漏れ（実行担当が未定義の Job ができること）をコンパイルエラーにする。
 */
export type JobExecutors = Readonly<Record<JobName, RefreshAccountsExecutor>>

/** Handler の依存。Composition Root が組み立てて注入する。 */
export interface AutomationHandlerDependencies {
  /** Router が受理した Job の実行担当を引く対応表（未知の Job は Router が拒否済み）。 */
  readonly executors: JobExecutors
  readonly sessionProvider: SessionProvider
}

/**
 * Lambda のハンドラー。検証済みの Job を実行し、機密情報を含まない契約へ写した結果を返す。
 * 例外は伝播させず、判定不能（UNKNOWN）として再試行判定を実行基盤へ委ねる（fail closed）。
 */
export type AutomationHandler = (event: unknown) => Promise<ApplicationResult>

/**
 * Handler を組み立てる。
 * 不正な入力は実行前に拒否し（Use Case・セッション取得を呼ばない）、セッション取得の失敗は
 * その分類を写す。Router を含む実行全体の例外は内容を出さず UNKNOWN へ写す（例外文字列は
 * URL・DOM・Secret を含み得るため、出力へ持ち込む経路を作らない）。
 */
export const createAutomationHandler = (
  dependencies: AutomationHandlerDependencies,
): AutomationHandler => {
  const run = async (event: unknown): Promise<ApplicationResult> => {
    try {
      const route = routeJob(event)
      if (!route.ok) {
        return toFailureResult(route.error)
      }

      const session = await dependencies.sessionProvider()
      if (!session.ok) {
        return toFailureResult(session.error)
      }

      return await dependencies.executors[route.value.job].execute({
        session: session.value,
        attempt: route.value.attempt,
      })
    } catch {
      return toFailureResult(createDomainError('UNKNOWN'))
    }
  }

  return run
}
