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
 * エラー分類。message 等の自由文字列は持たない
 * （自由文字列は Secret・金融情報の混入経路になり、ログの Allow List も破る）。
 * SECRET_* と ACCESS_DENIED は Secret Store Adapter が区別する取得失敗の語彙と一致させる。
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
 * 再試行できるエラー分類の対応表。
 * 一時障害・受付確認不能・判定不能のみ再試行する。認証（再ログインが要る）、Secret、
 * 対象特定（対象が無い・曖昧）、明示的な拒否は再試行しても回復しないため対象外
 * （欠如・破損・失効は区別して fail closed で停止する）。
 */
const RETRYABLE_ERROR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'TEMPORARY_FAILURE',
  'REFRESH_NOT_ACCEPTED',
  'UNKNOWN',
])

/** エラー分類が再試行可能かを返す。 */
export const isRetryableErrorCode = (code: ErrorCode): boolean => RETRYABLE_ERROR_CODES.has(code)

/** Use Case の Application Result。終状態（status）と失敗の分類（errorCode）で表す。 */
export interface ApplicationResult {
  readonly status: RefreshAccountsStatus
  /** 失敗の分類。SUCCESS / PARTIAL_SUCCESS では持たない。 */
  readonly errorCode?: ErrorCode
}

/**
 * 一括更新の観測結果を Application Result へ写像する（純関数）。
 * 認証セッションの失効を最優先で失敗にする（fail closed。受付の有無によらず停止する）。
 * 受付が確認できない場合は、失敗の観測があれば明示的な拒否（再試行しても回復しない）、
 * 観測がなければ受付確認不能（一時障害の可能性があるため再試行する）として区別する。
 * 一部の行だけが失敗した場合は部分成功とし、errorCode を付けない
 * （部分失敗を再試行の対象にするかは Use Case 側の判断として残す）。
 */
export const toApplicationResult = (outcome: RefreshAccountsOutcome): ApplicationResult => {
  if (outcome.authLost) return { status: 'FAILURE', errorCode: 'AUTH_REQUIRED' }

  if (outcome.acceptance === 'NOT_ACCEPTED') {
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
