import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

import { isSessionState } from './session-state.js'
import type { SessionState } from './session-state.js'

/**
 * 認証セッション（Cookie と localStorage）の保存と読込。
 * 中身は Cookie / セッショントークンを含む Secret のため、返り値の内容を
 * ログ・エラー・標準出力へ出さない（パスは出力してよい）。ADR-0012 / ADR-0013。
 */

/** セッション読込の結果。欠如と破損を区別して fail closed で扱う（ADR-0011）。 */
export type SessionLoadResult =
  | { readonly status: 'OK'; readonly sessionState: SessionState }
  | { readonly status: 'SESSION_MISSING' }
  | { readonly status: 'SESSION_INVALID' }

/**
 * セッションファイルを読み込む。
 * ファイル欠如は SESSION_MISSING、読込失敗・JSON 破損・形の不一致は SESSION_INVALID を返す。
 * group / other に権限があるファイル（他ユーザーが読める状態）は、Secret の漏えいにつながるため
 * 内容を読まずに SESSION_INVALID とする（fail closed。保存側は 0600 で作成する）。
 * 例外内容は返さない（JSON.parse のエラーメッセージは入力の断片を含み得るため）。
 */
export const readSessionFile = (filePath: string): SessionLoadResult => {
  if (!existsSync(filePath)) return { status: 'SESSION_MISSING' }

  // Windows は POSIX の権限ビットを再現しないため、この検査は行わない。
  if (process.platform !== 'win32') {
    try {
      if ((statSync(filePath).mode & 0o077) !== 0) return { status: 'SESSION_INVALID' }
    } catch {
      // stat に失敗する場合（破損・権限なし）も読込失敗として扱う。
      return { status: 'SESSION_INVALID' }
    }
  }

  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    return { status: 'SESSION_INVALID' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { status: 'SESSION_INVALID' }
  }

  if (!isSessionState(parsed)) return { status: 'SESSION_INVALID' }
  return { status: 'OK', sessionState: parsed }
}

/**
 * セッションファイルを保存する。
 * 新規作成するディレクトリは 0700、ファイルは常に 0600 にする。既存ディレクトリの権限は変更しない
 * （MF_SESSION_FILE で任意のディレクトリを指定できるため）。
 * 既存ファイルは一時ファイル（0600）へ書いてから置換し、書き込み途中の緩い権限の窓を作らない。
 * 一時ファイル名は推測できない名前にし、O_EXCL（'wx'）で新規作成する。予測可能な一時パスに
 * 事前に symlink を置き、参照先のファイルへ Secret を書き込ませる攻撃を防ぐ。
 * 内容は Secret のため、戻り値や例外へ含めない。
 */
export const saveSessionState = (filePath: string, sessionState: SessionState): void => {
  const directory = dirname(filePath)
  mkdirSync(directory, { recursive: true, mode: 0o700 })

  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  let descriptor: number | null = null
  try {
    // 'wx' は既存ファイル・symlink があれば EEXIST で失敗する（追従しない）。
    descriptor = openSync(temporaryPath, 'wx', 0o600)
    writeFileSync(descriptor, `${JSON.stringify(sessionState, null, 2)}\n`)
    closeSync(descriptor)
    descriptor = null
    renameSync(temporaryPath, filePath)
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor)
      } catch {
        // 後始末の失敗より元のエラーを優先する。
      }
    }
    try {
      rmSync(temporaryPath, { force: true })
    } catch {
      // 一時ファイルの後始末に失敗しても、元のエラーを優先する。
    }
    throw error
  }
}
