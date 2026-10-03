import type { LogSink } from '@mf-suite/security'

/**
 * CLI の構造化ログの出力境界。process（標準エラー）へ直接触れる箇所をこのモジュールに閉じ、
 * 判定・写像を置く層（session-cli.ts / refresh-accounts-cli.ts）から process を触らない。
 */

/**
 * 構造化ログを stderr へ 1 行ずつ書く sink。stdout は status 行の専有に保ち、
 * 運用時のログ（JSON 行）と契約（status 行）が混ざらないようにする。
 * 出力する field は構造化ロガーの allow list（timestamp / application / job / status /
 * attempt / durationMs / errorCode）に限られる。
 */
export const writeStructuredLogToStderr: LogSink = (jsonLine) => {
  process.stderr.write(`${jsonLine}\n`)
}
