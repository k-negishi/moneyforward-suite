/**
 * Application Core のエラー体系（job 非依存）。
 * message 等の自由文字列は持たない（自由文字列は Secret・金融情報の混入経路になり、
 * ログの Allow List も破る）。分類（code）だけを運び、再試行可否は対応表から導出する。
 */

/**
 * エラー分類。SECRET_* と ACCESS_DENIED は Secret Store Adapter が区別する
 * 取得失敗の語彙と一致させる。
 */
export type ErrorCode =
  | 'AUTH_REQUIRED'
  | 'SESSION_MISSING'
  | 'SESSION_INVALID'
  | 'INVALID_JOB'
  | 'TARGET_NOT_FOUND'
  | 'TARGET_AMBIGUOUS'
  | 'REFRESH_REJECTED'
  | 'REFRESH_NOT_ACCEPTED'
  | 'TEMPORARY_FAILURE'
  | 'SECRET_NOT_FOUND'
  | 'SECRET_INVALID'
  | 'ACCESS_DENIED'
  | 'UNKNOWN'

/**
 * 語彙と再試行可否の対応表（唯一の定義）。
 * 再試行するのは一時障害・受付確認不能・判定不能だけとする。認証（再ログインという
 * ユーザー操作が要る）・Secret（構成の問題）・対象特定（対象が無い・曖昧）・明示的な拒否は、
 * 再試行しても回復しないため対象外とする。
 */
const ERROR_CODE_RETRYABLE: Readonly<Record<ErrorCode, boolean>> = {
  AUTH_REQUIRED: false,
  SESSION_MISSING: false,
  SESSION_INVALID: false,
  INVALID_JOB: false,
  TARGET_NOT_FOUND: false,
  TARGET_AMBIGUOUS: false,
  REFRESH_REJECTED: false,
  REFRESH_NOT_ACCEPTED: true,
  TEMPORARY_FAILURE: true,
  SECRET_NOT_FOUND: false,
  SECRET_INVALID: false,
  ACCESS_DENIED: false,
  UNKNOWN: true,
}

/** 語彙の集合。対応表から導出し、二重定義を作らない。 */
const ERROR_CODES: ReadonlySet<string> = new Set(Object.keys(ERROR_CODE_RETRYABLE))

/**
 * 値がエラー分類の語彙に含まれるかを判定する。
 * Adapter など実行時の境界で、キャスト混入した未知の値を検証するために公開する。
 */
export const isErrorCode = (value: unknown): value is ErrorCode =>
  typeof value === 'string' && ERROR_CODES.has(value)

/**
 * 語彙外の値を UNKNOWN へ丸める（内部）。
 * 正規化の規則をこの 1 箇所に固定し、生成と再試行可否の判断を一致させる。
 */
const normalizeErrorCode = (value: unknown): ErrorCode => (isErrorCode(value) ? value : 'UNKNOWN')

/** エラー分類が再試行可能かを返す。語彙外の値は UNKNOWN として扱う（再試行可）。 */
export const isRetryableErrorCode = (code: ErrorCode): boolean =>
  ERROR_CODE_RETRYABLE[normalizeErrorCode(code)]

declare const domainErrorBrand: unique symbol

/**
 * Domain Error。分類（code）だけを持ち、再試行可否は対応表から導出する。
 * 生成は createDomainError に型で強制する。ブランドは型レベルのみ（ファントム）で、
 * 実行時の形状は分類だけのまま。
 */
export interface DomainError {
  readonly code: ErrorCode
  readonly [domainErrorBrand]: true
}

/**
 * エラー分類から Domain Error を作る（唯一の生成経路）。
 * 語彙外の値は UNKNOWN へ丸める（fail closed。生の文字列がログの errorCode として
 * 流れる経路を断つ）。
 */
export const createDomainError = (code: ErrorCode): DomainError =>
  ({ code: normalizeErrorCode(code) }) as DomainError
