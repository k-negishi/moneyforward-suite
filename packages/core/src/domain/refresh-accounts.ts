import type { DomainError, ErrorCode } from '../errors.js'

/**
 * 金融機関のデータ一括更新（refresh-accounts）のドメイン語彙。
 * 行テキスト・口座名・URL は型に載せない（Secret・金融情報が Core の型を通じて
 * ログ・エラー・別の Application へ流れ込む経路を型で断つ）。
 */

/** 一括更新の要求が MoneyForward ME 側に受け付けられたか。 */
export type RefreshAcceptance = 'ACCEPTED' | 'NOT_ACCEPTED'

/**
 * 受付・結果判定の根拠。件数と真偽値のみを持ち、行テキストは持たない。
 * 判定は「行の変化」という観測可能な状態変化に基づく（クリックの成否では判定しない）。
 */
export interface RefreshAccountsEvidence {
  /** 観測した対象行数。 */
  readonly observedRowCount: number
  /** 状態変化（更新日時の変化等）が観測された行数。 */
  readonly changedRowCount: number
  /** 失敗（明示的なエラー表示等）が観測された行数。 */
  readonly failedRowCount: number
  /** 進行中シグナル（更新中表示等）が新規に出現したか。 */
  readonly inProgressAppeared: boolean
}

/** 一括更新の観測結果。受付の有無と、その根拠、認証状態の変化を表す。 */
export interface RefreshAccountsOutcome {
  readonly acceptance: RefreshAcceptance
  readonly evidence: RefreshAccountsEvidence
  /** 処理中に認証セッションの失効を検知したか。true の場合は受付の有無によらず停止する。 */
  readonly authLost: boolean
}

/**
 * Use Case の終状態。
 * NO_REFRESH_NEEDED は語彙だけを定義し、現時点では写像で発火させない
 * （「更新不要」の判定条件が実機で未確認のため。条件が確認できたら写像に追加する）。
 */
export type RefreshAccountsStatus = 'SUCCESS' | 'PARTIAL_SUCCESS' | 'NO_REFRESH_NEEDED' | 'FAILURE'

/**
 * Use Case の Application Result。
 * errorCode は FAILURE のときだけ持つ（失敗以外にエラー分類が付かないことを型で表す）。
 */
export type ApplicationResult =
  | { readonly status: 'SUCCESS' | 'PARTIAL_SUCCESS' | 'NO_REFRESH_NEEDED' }
  | { readonly status: 'FAILURE'; readonly errorCode: ErrorCode }

/**
 * 一括更新の観測結果を Application Result へ写像する（純関数）。
 * 認証セッションの失効を最優先で失敗にする（fail closed。受付の有無によらず停止する）。
 * 受付は ACCEPTED 以外（語彙外れの値を含む）をすべて「確認できない」ものとして失敗側に倒し、
 * そのうち失敗の観測があれば明示的な拒否（再試行しても回復しない）、
 * 観測がなければ受付確認不能（一時障害の可能性があるため再試行する）として区別する。
 * 一部の行だけが失敗した場合は部分成功とし、errorCode を付けない
 * （部分失敗を再試行の対象にするかは Use Case 側の判断として残す）。
 * SUCCESS は「受付が確認でき、失敗の観測がない」ことを表し、更新の完了確認ではない
 * （進行中シグナルの出現だけでも受付の確認として成功とする）。
 */
export const toApplicationResult = (outcome: RefreshAccountsOutcome): ApplicationResult => {
  if (outcome.authLost) {
    return { status: 'FAILURE', errorCode: 'AUTH_REQUIRED' }
  }

  // 判定は ACCEPTED との比較で行い、受付の語彙が増えても受付側へ倒れないようにする（fail closed）。
  if (outcome.acceptance !== 'ACCEPTED') {
    return outcome.evidence.failedRowCount > 0
      ? { status: 'FAILURE', errorCode: 'REFRESH_REJECTED' }
      : { status: 'FAILURE', errorCode: 'REFRESH_NOT_ACCEPTED' }
  }

  if (outcome.evidence.failedRowCount > 0) {
    return outcome.evidence.changedRowCount > 0
      ? { status: 'PARTIAL_SUCCESS' }
      : { status: 'FAILURE', errorCode: 'REFRESH_REJECTED' }
  }

  return { status: 'SUCCESS' }
}

/**
 * Domain Error を失敗の Application Result へ写像する（正準の写像）。
 * 呼び出し側が失敗結果を手組みしないための入口とし、分類の付け方を 1 箇所に固定する。
 */
export const toFailureResult = (error: DomainError): ApplicationResult => ({
  status: 'FAILURE',
  errorCode: error.code,
})
