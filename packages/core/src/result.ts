import type { DomainError } from './errors.js'

/**
 * Use Case・Port の結果。成功は値、失敗は Domain Error で表す。
 * 例外は境界（Adapter）で捕捉し、この型へ変換して Core へ返す。
 */
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DomainError }
