import type {
  ErrorCode,
  LogApplication,
  LogEvent,
  LogJob,
  LoggerPort,
  LogStatus,
} from '@mf-suite/core'
import { isErrorCode } from '@mf-suite/core'

/**
 * Allow List 方式の構造化ロガー。出力できる field を
 * timestamp / application / job / status / attempt / durationMs / errorCode に固定し、
 * message・例外文字列・stack のような自由文字列を一切受け取らない・出力しない。
 *
 * Allow List は型（core の LogEvent）と実行時の二重で守る。実行時は許可 field を 1 つずつ
 * 明示的に取り出して出力オブジェクトを組むため、イベントに混ぜられた未知の key は出力へ
 * 現れない（スプレッド・JSON.stringify(event) のような丸ごと直列化はしない）。
 * errorCode は core の語彙で実行時に検証し、語彙外の値は UNKNOWN へ丸める
 * （core の正規化方針と一致させる）。
 */

/** ログ 1 行分の出力。Allow List の field と、ロガーが付与する timestamp だけを持つ。 */
export interface StructuredLogRecord {
  /** ISO 8601（UTC）。 */
  readonly timestamp: string
  readonly application: LogApplication
  readonly job: LogJob
  readonly status: LogStatus
  readonly attempt: number
  readonly durationMs: number
  /** 失敗の分類。成功時は key 自体を持たない。 */
  readonly errorCode?: ErrorCode
}

/**
 * 1 イベント分の JSON テキスト（改行を含まない 1 行）を受け取る出力先。
 * テストでは捕捉用の関数へ差し替える。
 */
export type LogSink = (jsonLine: string) => void

export interface StructuredLoggerOptions {
  /**
   * このロガーが扱う application。イベントが主張する application と一致しない場合は
   * 出力しない（配線・キャストの異常であり、値が信頼できないため Fail Closed で捨てる）。
   */
  readonly application: LogApplication
  /** 省略時は 1 イベント 1 行で stdout へ出力する。 */
  readonly sink?: LogSink
}

/** 既定の出力先。1 イベント = 1 行（改行付き）で stdout へ出す。 */
const writeJsonLineToStdout: LogSink = (jsonLine) => {
  process.stdout.write(`${jsonLine}\n`)
}

/**
 * errorCode を語彙で検証する。語彙外の値（キャストで混入した未知の値）は
 * UNKNOWN へ丸め、生の値が出力へ流れる経路を断つ（core の正規化方針と一致）。
 */
const normalizeErrorCode = (value: ErrorCode | undefined): ErrorCode | undefined => {
  if (value === undefined) return undefined
  return isErrorCode(value) ? value : 'UNKNOWN'
}

/**
 * イベントから出力オブジェクトを組む。許可 field を 1 つずつ取り出し、
 * 成功時（errorCode なし）は errorCode の key 自体を作らない。
 */
const toRecord = (
  application: LogApplication,
  event: LogEvent,
  timestamp: string,
): StructuredLogRecord => {
  const errorCode = normalizeErrorCode(event.errorCode)

  if (errorCode === undefined) {
    return {
      timestamp,
      application,
      job: event.job,
      status: event.status,
      attempt: event.attempt,
      durationMs: event.durationMs,
    }
  }

  return {
    timestamp,
    application,
    job: event.job,
    status: event.status,
    attempt: event.attempt,
    durationMs: event.durationMs,
    errorCode,
  }
}

/**
 * 構造化ロガーを作る。application はロガーへ束ね、イベント側の application と
 * 一致することを確認してから出力する。timestamp は実装が ISO 8601 で付与する。
 */
export const createStructuredLogger = (options: StructuredLoggerOptions): LoggerPort => {
  const sink = options.sink ?? writeJsonLineToStdout

  return {
    log(event: LogEvent): void {
      if (event.application !== options.application) return

      sink(JSON.stringify(toRecord(options.application, event, new Date().toISOString())))
    },
  }
}
