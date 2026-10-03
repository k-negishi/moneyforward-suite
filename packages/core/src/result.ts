import { isRetryableErrorCode } from './domain/refresh-accounts.js'
import type { ErrorCode } from './domain/refresh-accounts.js'

/**
 * Use Case・Port の結果。成功は値、失敗は Domain Error で表す。
 * 例外は境界（Adapter）で捕捉し、この型へ変換して Core へ返す。
 */
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DomainError }

/**
 * Domain Error。分類（code）と再試行可否のみを持ち、message 等の自由文字列は持たない
 * （自由文字列は Secret・金融情報の混入経路になり、ログの Allow List も破る）。
 */
export interface DomainError {
  readonly code: ErrorCode
  readonly retryable: boolean
}

/** エラー分類から Domain Error を作る。再試行可否は分類から一意に決まる。 */
export const createDomainError = (code: ErrorCode): DomainError => ({
  code,
  retryable: isRetryableErrorCode(code),
})
