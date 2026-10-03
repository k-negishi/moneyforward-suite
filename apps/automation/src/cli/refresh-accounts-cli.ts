import type { ApplicationResult, ErrorCode, RefreshAccountsStatus } from '@mf-suite/core'
import { isErrorCode } from '@mf-suite/core'
import type { LogSink } from '@mf-suite/security'

import type { AutomationHandler } from '../handler.js'

/**
 * refresh-accounts CLI の引数解析・終了コード写像・実行本体。
 * エントリポイントから切り離して依存を注入可能にし、実ブラウザ・実サービスへ触れずに
 * 引数の受理範囲と終了コードの契約を単体テストで固定できるようにする。
 * 出力の契約: stdout は `status=...`（失敗時は `errorCode=...` を続ける）の 1 行だけ。
 * stderr は使い方の案内（不正入力時）と構造化ログ（allow list の field だけの JSON 行）。
 * Secret・Cookie・金融情報は出力しない。
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

/** CLI が受け付けるオプション。ブラウザの表示方法だけを選べる（allow list の語彙）。 */
export interface RefreshAccountsCliOptions {
  /** ブラウザを表示するか（既定は headless）。 */
  readonly headless: boolean
}

/**
 * 使い方の案内（不正入力時に stderr へ出力する固定文言）。可変値を混ぜない
 * （引数の値・パス・例外内容が出力へ流れる経路を作らない）。
 */
export const REFRESH_ACCOUNTS_USAGE = `使い方: pnpm refresh-accounts [--headed | --headless]
  --headed   ブラウザを表示して実行する（既定は headless）
  --headless ブラウザを表示せずに実行する`

/**
 * 終了コード。呼び出し元（スクリプト・運用手順）が分岐に使う契約として固定する。
 * 0 = 成功、2 = 認証が必要、3 = 更新不要、4 = 部分成功、64 = 不正入力、1 = その他。
 */
const EXIT_CODE_SUCCESS = 0
const EXIT_CODE_FAILURE = 1
const EXIT_CODE_AUTH_REQUIRED = 2
const EXIT_CODE_NO_REFRESH_NEEDED = 3
const EXIT_CODE_PARTIAL_SUCCESS = 4
/** 不正入力（使い方の誤り）。引数の誤用を他の失敗と区別する（sysexits の EX_USAGE と同じ値）。 */
const EXIT_CODE_INVALID_INPUT = 64

/**
 * 成功系の status → 終了コードの対応表。Record 型で網羅を型検査に強制し、
 * status の語彙が増えたときの写像漏れをコンパイルエラーにする。
 * 部分成功（4）と更新不要（3）は成功（0）と区別し、呼び出し元が結果を分岐できるようにする。
 */
export const REFRESH_ACCOUNTS_EXIT_CODE_BY_STATUS: Readonly<
  Record<Exclude<RefreshAccountsStatus, 'FAILURE'>, number>
> = {
  SUCCESS: EXIT_CODE_SUCCESS,
  PARTIAL_SUCCESS: EXIT_CODE_PARTIAL_SUCCESS,
  NO_REFRESH_NEEDED: EXIT_CODE_NO_REFRESH_NEEDED,
}

/**
 * 失敗の errorCode → 終了コードの対応表（全語彙の写像を固定する唯一の定義）。
 * 認証の 3 分類（AUTH_REQUIRED / SESSION_MISSING / SESSION_INVALID）は
 * 再ログインという同じ対処へ導くため 2 に揃え、不正入力（INVALID_JOB）は引数の誤用として
 * 64 に区別し、残り（一時障害・拒否・対象特定・Secret・判定不能）は 1 に集約する。
 */
export const REFRESH_ACCOUNTS_EXIT_CODE_BY_ERROR_CODE: Readonly<Record<ErrorCode, number>> = {
  AUTH_REQUIRED: EXIT_CODE_AUTH_REQUIRED,
  SESSION_MISSING: EXIT_CODE_AUTH_REQUIRED,
  SESSION_INVALID: EXIT_CODE_AUTH_REQUIRED,
  INVALID_JOB: EXIT_CODE_INVALID_INPUT,
  TARGET_NOT_FOUND: EXIT_CODE_FAILURE,
  TARGET_AMBIGUOUS: EXIT_CODE_FAILURE,
  REFRESH_REJECTED: EXIT_CODE_FAILURE,
  REFRESH_NOT_ACCEPTED: EXIT_CODE_FAILURE,
  TEMPORARY_FAILURE: EXIT_CODE_FAILURE,
  SECRET_NOT_FOUND: EXIT_CODE_FAILURE,
  SECRET_INVALID: EXIT_CODE_FAILURE,
  ACCESS_DENIED: EXIT_CODE_FAILURE,
  UNKNOWN: EXIT_CODE_FAILURE,
}

/**
 * 引数を解析する。許可したオプション（--headed / --headless）を 1 回だけ受け付け、
 * 未知のフラグ・位置引数・値付き（--headed=...）・重複（同時指定を含む）は null を返す
 * （呼び出し側が使い方を表示し、不正入力として停止する）。allow list のため、
 * URL・Selector・JavaScript・Shell Command・attempt を引数から指定する経路は存在しない。
 */
export const parseRefreshAccountsArgs = (
  argv: readonly string[],
): RefreshAccountsCliOptions | null => {
  let mode: 'headed' | 'headless' | null = null

  for (const arg of argv) {
    switch (arg) {
      case '--headed':
      case '--headless':
        if (mode !== null) {
          return null
        }
        mode = arg === '--headed' ? 'headed' : 'headless'
        break
      default:
        return null
    }
  }

  return { headless: mode !== 'headed' }
}

/** 成功系 status の語彙（終了コード対応表の key から導出し、二重定義を作らない）。 */
const SUCCESS_STATUSES: ReadonlySet<string> = new Set(
  Object.keys(REFRESH_ACCOUNTS_EXIT_CODE_BY_STATUS),
)

/** 値が成功系 status の語彙に含まれるかを判定する（実行時の境界の検証）。 */
const isSuccessStatus = (value: unknown): value is Exclude<RefreshAccountsStatus, 'FAILURE'> =>
  typeof value === 'string' && SUCCESS_STATUSES.has(value)

/** 実行時検証を通した Application Result。語彙外の値は UNKNOWN（失敗）へ正規化済み。 */
type NormalizedApplicationResult =
  | { readonly status: 'FAILURE'; readonly errorCode: ErrorCode }
  | { readonly status: Exclude<RefreshAccountsStatus, 'FAILURE'> }

/**
 * Application Result を実行時に検証して正規化する。status / errorCode が語彙外
 * （キャスト混入など型を迂回した値）の場合は UNKNOWN（失敗）へ落とし、生の値が
 * 出力へ流れる経路を断つ（fail closed。判定不能は再試行可能側の 1 へ集約する）。
 */
const normalizeApplicationResult = (result: ApplicationResult): NormalizedApplicationResult => {
  if (result.status === 'FAILURE') {
    const errorCode: unknown = result.errorCode
    return { status: 'FAILURE', errorCode: isErrorCode(errorCode) ? errorCode : 'UNKNOWN' }
  }
  const status: unknown = result.status
  if (isSuccessStatus(status)) {
    return { status }
  }
  return { status: 'FAILURE', errorCode: 'UNKNOWN' }
}

/**
 * Application Result を出力の 1 行へ写す（status と errorCode だけ。自由文字列は載せない）。
 * 失敗は `status=FAILURE errorCode=...`、成功系は `status=...` の 1 行にする。
 */
const formatApplicationResult = (result: ApplicationResult): string => {
  const normalized = normalizeApplicationResult(result)
  return normalized.status === 'FAILURE'
    ? `status=FAILURE errorCode=${normalized.errorCode}`
    : `status=${normalized.status}`
}

/** Application Result を終了コードへ写す（失敗は errorCode、成功系は status の対応表で引く）。 */
export const toExitCode = (result: ApplicationResult): number => {
  const normalized = normalizeApplicationResult(result)
  return normalized.status === 'FAILURE'
    ? REFRESH_ACCOUNTS_EXIT_CODE_BY_ERROR_CODE[normalized.errorCode]
    : REFRESH_ACCOUNTS_EXIT_CODE_BY_STATUS[normalized.status]
}

/** CLI の依存。エントリポイントが実装を差し込み、テストは合成実装を渡す。 */
export interface RefreshAccountsCliDependencies {
  /**
   * 実行の直前に Handler を組み立てる（Composition Root の呼び出し）。
   * 業務判断（status / errorCode の決定）は Handler と Use Case が担い、CLI は写像と出力だけを行う。
   */
  readonly createHandler: (options: RefreshAccountsCliOptions) => AutomationHandler
  readonly writeStdout: (line: string) => void
  readonly writeStderr: (line: string) => void
}

/**
 * refresh-accounts を 1 回だけ実行する（再試行・待機は行わない。実行基盤の責務）。
 * 引数を allow list で検証し、不正なら Handler を組み立てずに使い方を案内して停止する。
 * Handler へ渡す入力はこのコードが固定する（job だけを渡し、attempt は Job Router の既定 1）。
 * 例外の内容は出力しない（URL・DOM・Cookie が混ざり得るため、判定不能 = UNKNOWN で停止する）。
 */
export const runRefreshAccounts = async (
  dependencies: RefreshAccountsCliDependencies,
  argv: readonly string[],
): Promise<number> => {
  const options = parseRefreshAccountsArgs(argv)
  if (options === null) {
    dependencies.writeStderr(REFRESH_ACCOUNTS_USAGE)
    dependencies.writeStdout('status=FAILURE errorCode=INVALID_JOB')
    return REFRESH_ACCOUNTS_EXIT_CODE_BY_ERROR_CODE.INVALID_JOB
  }

  try {
    const handler = dependencies.createHandler(options)
    const result = await handler({ job: 'refresh-accounts' })
    dependencies.writeStdout(formatApplicationResult(result))
    return toExitCode(result)
  } catch {
    // 例外の内容は出さない（URL・DOM・Cookie が混ざり得るため）。
    dependencies.writeStdout('status=FAILURE errorCode=UNKNOWN')
    return REFRESH_ACCOUNTS_EXIT_CODE_BY_ERROR_CODE.UNKNOWN
  }
}
