import type { RefreshAccountsStatus } from '../domain/refresh-accounts.js'
import type { ErrorCode } from '../errors.js'

/** ログに記録できる application（Allow List）。 */
export type LogApplication = 'automation'

/** ログに記録できる job（Allow List）。 */
export type LogJob = 'refresh-accounts'

/** ログに記録できる status。STARTED は Use Case の開始ログ用。 */
export type LogStatus = RefreshAccountsStatus | 'STARTED'

/**
 * job の語彙の定義（唯一の定義）。Record 型で網羅を型検査に強制し、
 * LogJob へ値を追加したときの更新漏れをコンパイルエラーにする。
 */
const LOG_JOBS: Readonly<Record<LogJob, true>> = {
  'refresh-accounts': true,
}

/** status の語彙の定義（唯一の定義）。網羅の保証は LOG_JOBS と同様。 */
const LOG_STATUSES: Readonly<Record<LogStatus, true>> = {
  STARTED: true,
  SUCCESS: true,
  PARTIAL_SUCCESS: true,
  NO_REFRESH_NEEDED: true,
  FAILURE: true,
}

/** 語彙の集合。定義表から導出し、二重定義を作らない。 */
const LOG_JOB_SET: ReadonlySet<string> = new Set(Object.keys(LOG_JOBS))
const LOG_STATUS_SET: ReadonlySet<string> = new Set(Object.keys(LOG_STATUSES))

/**
 * 値がログ job の語彙に含まれるかを判定する。
 * 型で守れない境界（キャスト混入・JS からの利用）で実行時の値を検証するために公開する。
 */
export const isLogJob = (value: unknown): value is LogJob =>
  typeof value === 'string' && LOG_JOB_SET.has(value)

/** 値がログ status の語彙に含まれるかを判定する（isLogJob と同様の用途）。 */
export const isLogStatus = (value: unknown): value is LogStatus =>
  typeof value === 'string' && LOG_STATUS_SET.has(value)

/**
 * ログに記録できる field だけを持つイベント。自由文字列フィールドを持たない
 * （Secret・Cookie・セッショントークン・金融明細・URL・DOM の混入経路を型で断つ）。
 * timestamp は Logger の実装が付与するため、この型には含めない。
 */
export interface LogEvent {
  readonly application: LogApplication
  readonly job: LogJob
  readonly status: LogStatus
  /**
   * job の試行回数。1 起点の整数でなければならない。0 以下・非整数・NaN・数値以外の
   * イベントは Logger の実装が無言で落とす（Fail Closed）。
   */
  readonly attempt: number
  /**
   * 所要時間（ミリ秒）。0 以上の整数でなければならない。負数・非整数・NaN・数値以外の
   * イベントは Logger の実装が無言で落とす（Fail Closed）。
   */
  readonly durationMs: number
  /** 失敗の分類。成功時は持たない。 */
  readonly errorCode?: ErrorCode
}

/** 構造化ログの出力能力（Port）。 */
export interface LoggerPort {
  log(event: LogEvent): void
}
