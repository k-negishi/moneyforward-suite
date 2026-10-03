import type { ErrorCode, RefreshAccountsStatus } from '../domain/refresh-accounts.js'

/** ログに記録できる application（Allow List）。 */
export type LogApplication = 'automation'

/** ログに記録できる job（Allow List）。 */
export type LogJob = 'refresh-accounts'

/**
 * ログに記録できる field だけを持つイベント。自由文字列フィールドを持たない
 * （Secret・Cookie・セッショントークン・金融明細・URL・DOM の混入経路を型で断つ）。
 * timestamp は Logger の実装が付与するため、この型には含めない。
 */
export interface LogEvent {
  readonly application: LogApplication
  readonly job: LogJob
  readonly status: RefreshAccountsStatus
  readonly attempt: number
  readonly durationMs: number
  /** 失敗の分類。成功時は持たない。 */
  readonly errorCode?: ErrorCode
}

/** 構造化ログの出力能力（Port）。 */
export interface LoggerPort {
  log(event: LogEvent): void
}
