import type { AuthSession, SessionVerification } from '@mf-suite/core'
import type { SessionLoadResult } from '@mf-suite/security'
import { formatSessionPathForDisplay, toAuthSession } from '@mf-suite/security'

import type { LoginSessionResult } from '../moneyforward/page-client.js'

/**
 * セッション CLI（session:login / session:check）の状態語彙・終了コード・固定文言と実行本体。
 * エントリポイントから切り離して依存を注入可能にし、実ブラウザ・実サービスへ触れずに
 * 出力と終了コードの契約を単体テストで固定できるようにする。
 * 出力の契約: stdout は `status=...` の 1 行（成功時は保存先の表示 1 行を追加）と、対話中（session:login）の
 * 人間向けの案内・プロンプト。stderr は再生成案内などの固定文言。
 * Cookie・セッショントークン・URL・例外内容は出力しない（セッションの値は表示用に整形したパスのみ）。
 */

/** session:login が返し得る状態。 */
export type SessionLoginStatus = 'SESSION_SAVED' | 'AUTH_REQUIRED' | 'TEMPORARY_FAILURE'

/** session:check が返し得る状態。欠如・破損・失効を区別し、有効と判定できた場合だけ成功にする。 */
export type SessionCheckStatus =
  | 'SESSION_VALID'
  | 'SESSION_MISSING'
  | 'SESSION_INVALID'
  | 'AUTH_REQUIRED'
  | 'TEMPORARY_FAILURE'

/** 終了コード: 0 = 保存成功、2 = 認証が必要（未完了・失効）、1 = その他（一時障害）。 */
export const SESSION_LOGIN_EXIT_CODE_BY_STATUS: Readonly<Record<SessionLoginStatus, number>> = {
  SESSION_SAVED: 0,
  AUTH_REQUIRED: 2,
  TEMPORARY_FAILURE: 1,
}

/** 終了コード: 0 = 有効、2 = 失効（認証が必要）、1 = 欠如・破損・判定不能。 */
export const SESSION_CHECK_EXIT_CODE_BY_STATUS: Readonly<Record<SessionCheckStatus, number>> = {
  SESSION_VALID: 0,
  AUTH_REQUIRED: 2,
  SESSION_MISSING: 1,
  SESSION_INVALID: 1,
  TEMPORARY_FAILURE: 1,
}

/**
 * 手動ログインの結果を CLI の状態へ写す（純関数）。
 * NOT_COMPLETED（Enter 待ちの EOF・中断）は認証が完了していない状態として AUTH_REQUIRED に写す。
 */
export const toSessionLoginStatus = (result: LoginSessionResult): SessionLoginStatus => {
  switch (result.status) {
    case 'SESSION_SAVED':
      return 'SESSION_SAVED'
    case 'NOT_COMPLETED':
    case 'AUTH_REQUIRED':
      return 'AUTH_REQUIRED'
    case 'TEMPORARY_FAILURE':
      return 'TEMPORARY_FAILURE'
  }
}

/**
 * セッション読込の結果と検証結果を CLI の状態へ写す（純関数）。
 * 欠如（SESSION_MISSING）・破損（SESSION_INVALID）は読込結果の時点で確定する。
 * 検証が判定不能（UNKNOWN）の場合は有効とも失効とも決めず、TEMPORARY_FAILURE とする（fail closed）。
 */
export const toSessionCheckStatus = (
  load: SessionLoadResult,
  verification: SessionVerification,
): SessionCheckStatus => {
  if (load.status === 'SESSION_MISSING') {
    return 'SESSION_MISSING'
  }
  if (load.status === 'SESSION_INVALID') {
    return 'SESSION_INVALID'
  }
  if (verification === 'VALID') {
    return 'SESSION_VALID'
  }
  return verification === 'AUTH_REQUIRED' ? 'AUTH_REQUIRED' : 'TEMPORARY_FAILURE'
}

/** 手動ログインの案内（stdout。ログイン画面を開いた後に表示する）。 */
export const SESSION_LOGIN_INSTRUCTION = 'ブラウザで MoneyForward ME に手動ログインしてください。'

/** 認証チャレンジは自動回避しないことの案内（stdout）。 */
export const SESSION_LOGIN_CHALLENGE_NOTICE =
  'CAPTCHA・ワンタイムパスワード・新端末確認はご自身で対応してください（自動回避しません）。'

/** Enter 待機のプロンプト（stdout。stdin が閉じている場合は完了しなかったものとして扱う）。 */
export const SESSION_LOGIN_ENTER_PROMPT = 'ログインが完了したら Enter を押してください: '

/**
 * セッションの生成・再生成の案内（stderr・固定文言）。
 * 可変値を混ぜない（セッション値・URL・例外内容の出力経路を作らない）。
 */
export const SESSION_REGENERATE_GUIDANCE =
  'セッションを作り直すには、次のコマンドで手動ログインしてください: pnpm --filter @mf-suite/adapter-moneyforward-playwright session:login'

/**
 * セッションファイルの設定エラーの案内（stderr・固定文言）。
 * パス解決の失敗（MF_SESSION_FILE の相対パス指定・リポジトリルートの特定失敗など）を
 * 可変値なしの一般形で案内する。
 */
export const SESSION_CONFIG_ERROR_GUIDANCE = 'セッションの保存先パスの指定を確認してください'

/** セッションファイルのパス解決と出力の依存（両 CLI で共通）。 */
export interface SessionPathDependencies {
  readonly resolveSessionFilePath: () => string
  readonly writeStdout: (line: string) => void
  readonly writeStderr: (line: string) => void
}

/**
 * セッションファイルのパスを解決する。設定エラー（MF_SESSION_FILE の相対パス指定など）では
 * 例外の内容（指定値が混ざり得る）を出さず、固定文言を stderr に出して TEMPORARY_FAILURE を表示し、
 * null を返す（呼び出し側はそのまま一時障害として終了する）。
 */
const tryResolveSessionFilePath = (dependencies: SessionPathDependencies): string | null => {
  try {
    return dependencies.resolveSessionFilePath()
  } catch {
    dependencies.writeStdout('status=TEMPORARY_FAILURE')
    dependencies.writeStderr(SESSION_CONFIG_ERROR_GUIDANCE)
    return null
  }
}

/** session:login の依存。エントリポイントが実装を差し込み、テストは合成実装を渡す。 */
export interface SessionLoginDependencies extends SessionPathDependencies {
  /** 手動ログインの実行（ブラウザ操作と保存の判断は page-client の実装が担う）。 */
  readonly runManualLogin: (
    sessionFilePath: string,
    waitForLogin: () => Promise<boolean>,
  ) => Promise<LoginSessionResult>
  readonly waitForEnter: (message: string) => Promise<boolean>
}

/**
 * session:login を実行する。
 * ブラウザで手動ログインし、認証済みと確認できた場合だけセッションを保存する
 * （Password は扱わない。認証チャレンジの検知・未完了では保存せず AUTH_REQUIRED とする。
 * 保存の判断は page-client の実装側にあり、この CLI は結果の表示と終了コードだけを担う）。
 * 設定エラー（パス解決の失敗）は可変値の無い固定文言で案内し、その他の例外の内容は出力しない
 * （URL・DOM・Cookie が混ざり得るため）。
 */
export const runSessionLogin = async (dependencies: SessionLoginDependencies): Promise<number> => {
  const sessionFilePath = tryResolveSessionFilePath(dependencies)
  if (sessionFilePath === null) {
    return SESSION_LOGIN_EXIT_CODE_BY_STATUS.TEMPORARY_FAILURE
  }

  try {
    const result = await dependencies.runManualLogin(sessionFilePath, () => {
      dependencies.writeStdout(SESSION_LOGIN_INSTRUCTION)
      dependencies.writeStdout(SESSION_LOGIN_CHALLENGE_NOTICE)
      return dependencies.waitForEnter(SESSION_LOGIN_ENTER_PROMPT)
    })

    const status = toSessionLoginStatus(result)
    dependencies.writeStdout(`status=${status}`)
    if (status === 'SESSION_SAVED') {
      dependencies.writeStdout(`session ファイル: ${formatSessionPathForDisplay(sessionFilePath)}`)
    } else if (status === 'AUTH_REQUIRED') {
      dependencies.writeStderr(SESSION_REGENERATE_GUIDANCE)
    }
    return SESSION_LOGIN_EXIT_CODE_BY_STATUS[status]
  } catch {
    // 例外の内容は出さない（URL・DOM・Cookie が混ざり得るため）。
    dependencies.writeStdout('status=TEMPORARY_FAILURE')
    return SESSION_LOGIN_EXIT_CODE_BY_STATUS.TEMPORARY_FAILURE
  }
}

/** session:check の依存。エントリポイントが実装を差し込み、テストは合成実装を渡す。 */
export interface SessionCheckDependencies extends SessionPathDependencies {
  readonly readSessionFile: (filePath: string) => SessionLoadResult
  /** セッションの有効性の検証（ブラウザ操作は Adapter の Port 実装が担う）。 */
  readonly verifySession: (session: AuthSession) => Promise<SessionVerification>
}

/**
 * session:check を実行する。
 * セッションの欠如・破損は読み込みの時点で区別して停止し、読み込めた場合だけ検証で有効性を確認する
 * （欠如・破損ではブラウザを起動しない）。失効・欠如・破損では再生成の手順を固定文言で stderr に案内する
 * （stdout は `status=...` の 1 行。有効時は保存先の表示 1 行を追加する）。
 * 設定エラー（パス解決の失敗）は可変値の無い固定文言で案内し、その他の例外の内容は出力しない
 * （URL・DOM・Cookie が混ざり得るため）。
 */
export const runSessionCheck = async (dependencies: SessionCheckDependencies): Promise<number> => {
  const sessionFilePath = tryResolveSessionFilePath(dependencies)
  if (sessionFilePath === null) {
    return SESSION_CHECK_EXIT_CODE_BY_STATUS.TEMPORARY_FAILURE
  }

  try {
    const load = dependencies.readSessionFile(sessionFilePath)
    const verification: SessionVerification =
      load.status === 'OK'
        ? await dependencies.verifySession(toAuthSession(load.sessionState))
        : 'UNKNOWN'

    const status = toSessionCheckStatus(load, verification)
    dependencies.writeStdout(`status=${status}`)
    if (status === 'SESSION_VALID') {
      dependencies.writeStdout(`session ファイル: ${formatSessionPathForDisplay(sessionFilePath)}`)
    } else if (status !== 'TEMPORARY_FAILURE') {
      dependencies.writeStderr(SESSION_REGENERATE_GUIDANCE)
    }
    return SESSION_CHECK_EXIT_CODE_BY_STATUS[status]
  } catch {
    // 例外の内容は出さない（URL・DOM・Cookie が混ざり得るため）。
    dependencies.writeStdout('status=TEMPORARY_FAILURE')
    return SESSION_CHECK_EXIT_CODE_BY_STATUS.TEMPORARY_FAILURE
  }
}
