import type { RefreshExecutionOutcome, RefreshTargetsOutcome } from '../moneyforward/page-client.js'

/**
 * refresh CLI の引数解析・終了コード・使い方・状態写像。
 * エントリポイント（spike/refresh.ts）から切り離し、単体テストできるようにする。
 * 引数で URL / Selector / 操作を受け付けない（ADR-0010）。
 * 状態語彙（SpikeStatus）は暫定で、正式 CLI の語彙・終了コードへ置き換えるまでの間だけ使う。
 */

/** CLI が返し得る状態（語彙は暫定）。 */
export type SpikeStatus =
  | 'REFRESH_ACCEPTED'
  | 'REFRESH_AVAILABLE'
  | 'TEMPORARY_FAILURE'
  | 'AUTH_REQUIRED'
  | 'SESSION_MISSING'
  | 'SESSION_INVALID'
  | 'TARGET_NOT_FOUND'
  | 'TARGET_AMBIGUOUS'

/** 終了コード: 0 = 判定成功、2 = 認証が必要、1 = その他エラー。 */
export const EXIT_CODE_BY_STATUS: Record<SpikeStatus, number> = {
  REFRESH_AVAILABLE: 0,
  REFRESH_ACCEPTED: 0,
  TEMPORARY_FAILURE: 1,
  AUTH_REQUIRED: 2,
  SESSION_MISSING: 1,
  SESSION_INVALID: 1,
  TARGET_NOT_FOUND: 1,
  TARGET_AMBIGUOUS: 1,
}

/** CLI オプション。既定は headless・読み取りのみ。 */
export interface RefreshOptions {
  readonly headless: boolean
  readonly execute: boolean
}

export const REFRESH_USAGE = `使い方: node dist/spike/refresh.js [--headed | --headless] [--execute]
  --headed   ブラウザを表示して実行する（既定は headless）
  --headless ブラウザを表示せずに実行する
  --execute  金融機関のデータ一括更新を実行し、行ごとの変化から受付を確認する（既定は読み取りのみ）`

/**
 * 引数を解析する。許可したオプション以外、および --headed と --headless の
 * 矛盾する同時指定は null を返す（呼び出し側が使い方を表示して停止する）。
 */
export const parseRefreshArgs = (argv: readonly string[]): RefreshOptions | null => {
  let mode: 'headed' | 'headless' | null = null
  let execute = false

  for (const arg of argv) {
    switch (arg) {
      case '--headed':
        if (mode === 'headless') {
          return null
        }
        mode = 'headed'
        break
      case '--headless':
        if (mode === 'headed') {
          return null
        }
        mode = 'headless'
        break
      case '--execute':
        execute = true
        break
      default:
        return null
    }
  }

  return { headless: mode !== 'headed', execute }
}

/**
 * ページ操作の結果を CLI の状態語彙へ写す（純関数・暫定）。
 * 受付が確認できた場合のみ REFRESH_ACCEPTED とし、それ以外は停止側へ倒す（fail closed）。
 * 認証失効は受付の有無によらず AUTH_REQUIRED とする。
 */
export const toSpikeStatus = (
  outcome: RefreshTargetsOutcome | RefreshExecutionOutcome,
): SpikeStatus => {
  switch (outcome.status) {
    case 'AVAILABLE':
      return 'REFRESH_AVAILABLE'
    case 'OBSERVED':
      if (outcome.observation.authLost) return 'AUTH_REQUIRED'
      return outcome.observation.acceptance === 'ACCEPTED'
        ? 'REFRESH_ACCEPTED'
        : 'TEMPORARY_FAILURE'
    case 'AUTH_REQUIRED':
    case 'SESSION_INVALID':
    case 'TARGET_NOT_FOUND':
    case 'TARGET_AMBIGUOUS':
    case 'TEMPORARY_FAILURE':
      return outcome.status
  }
}
