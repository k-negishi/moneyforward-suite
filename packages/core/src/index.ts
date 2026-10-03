// Application Core（Domain / Application / Ports）の public API はここだけで公開する。
// 中身は PoC 実装で追加する。core は Framework / Runtime 非依存とし、
// playwright・aws-sdk・appium 等を持ち込まない（ADR-0006）。
export type { Result } from './result.js'

export type { DomainError, ErrorCode } from './errors.js'
export { createDomainError, isRetryableErrorCode } from './errors.js'

export type {
  ApplicationResult,
  RefreshAcceptance,
  RefreshAccountsEvidence,
  RefreshAccountsOutcome,
  RefreshAccountsStatus,
} from './domain/refresh-accounts.js'
export { toApplicationResult, toFailureResult } from './domain/refresh-accounts.js'

export type { AuthSession, MoneyForwardPort, SessionVerification } from './ports/money-forward-port.js'
export type { SecretId, SecretStorePort, SecretValue } from './ports/secret-store-port.js'
export type { LogApplication, LogEvent, LogJob, LogStatus, LoggerPort } from './ports/logger-port.js'
