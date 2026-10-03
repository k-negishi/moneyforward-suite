import type { SecretValue } from '@mf-suite/core'
import type { SessionLoadResult } from './session-file.js'
import { isSessionState } from './session-state.js'

/**
 * Secret Store に保存された認証セッション（セッションファイルと同じ直列化形式）の検証。
 * セッションの形式を知るのはセッション管理側（この package）に閉じ、Secret の値の中身を
 * Application・Adapter が解釈する経路を作らない。値は Cookie・セッショントークンを含む Secret の
 * ため、内容をログ・エラー・標準出力へ出さない（ADR-0011 / ADR-0013）。
 */

/**
 * Secret Store から取得した Secret の値を検証し、セッション読込の結果へ変換する。
 * 値が文字列でない・空・JSON として壊れている・セッションの形を満たさない場合は
 * SESSION_INVALID を返し、呼び出し側が fail closed で停止できるようにする。
 * 例外・失敗の内容（入力の断片を含み得る）は結果へ含めない。
 */
export const parseSessionSecret = (secret: SecretValue): SessionLoadResult => {
  // SecretValue のブランドは型レベルのみで、実行時の値は Secret Store が返した生の値。
  // 外部境界の値として実行時に型を検証してから解釈する。
  const raw: unknown = secret
  if (typeof raw !== 'string' || raw.length === 0) {
    return { status: 'SESSION_INVALID' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // JSON.parse のエラーメッセージは入力の断片を含み得るため、結果へ写さない。
    return { status: 'SESSION_INVALID' }
  }

  if (!isSessionState(parsed)) {
    return { status: 'SESSION_INVALID' }
  }
  return { status: 'OK', sessionState: parsed }
}
