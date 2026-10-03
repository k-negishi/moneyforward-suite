import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * セッションファイルのパス解決。
 * 認証セッションは Secret として扱い、既定ではリポジトリ内の git 管理外（.local/）に置く。
 * パスは表示してよい（内容・Cookie は出さない）。ADR-0012 / ADR-0013。
 */

/** セッションファイルのパスを上書きする環境変数名。 */
export const SESSION_FILE_ENV_VAR = 'MF_SESSION_FILE'

/** リポジトリルートからのセッションファイルの相対パス（.local/ は git 管理外）。 */
const SESSION_FILE_RELATIVE_PATH = '.local/moneyforward-session.json'

/** リポジトリルートの目印。workspace 定義ファイルの位置からルートを特定する。 */
const WORKSPACE_MARKER_FILE = 'pnpm-workspace.yaml'

/** 起点ディレクトリから親方向へ目印ファイルを探索し、リポジトリルートを返す。 */
const findRepositoryRoot = (startDirectory: string): string | null => {
  let current = startDirectory
  for (;;) {
    if (existsSync(join(current, WORKSPACE_MARKER_FILE))) return current

    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/**
 * セッションファイルの絶対パスを解決する。
 * 環境変数 MF_SESSION_FILE があればそれを優先し、無ければこのファイルの位置から
 * リポジトリルートを特定して <root>/.local/moneyforward-session.json に固定する。
 * 認証セッションは Secret として扱い、リポジトリ外へは置かない。
 */
export const resolveSessionFilePath = (): string => {
  const override = process.env[SESSION_FILE_ENV_VAR]
  if (override !== undefined && override.length > 0) {
    // 相対パスは起動ディレクトリ（cwd）依存で、意図しない場所のファイルを読み書きする事故につながるため受け付けない。
    if (!isAbsolute(override)) {
      throw new Error(`${SESSION_FILE_ENV_VAR} には絶対パスを指定してください（相対パスは受け付けません）`)
    }
    return override
  }

  const repositoryRoot = findRepositoryRoot(dirname(fileURLToPath(import.meta.url)))
  if (repositoryRoot === null) {
    throw new Error(
      'リポジトリルート（pnpm-workspace.yaml）を特定できないため、セッションファイルのパスを解決できません',
    )
  }
  return join(repositoryRoot, SESSION_FILE_RELATIVE_PATH)
}

/**
 * セッションファイルのパスを表示用に整形する。
 * 絶対パスにはユーザー名等が含まれ得るため、リポジトリルート相対にして出力する。
 * ルートを特定できない場合やリポジトリ外のパス（MF_SESSION_FILE の指定）は、ファイル名のみを返す。
 */
export const formatSessionPathForDisplay = (filePath: string): string => {
  const repositoryRoot = findRepositoryRoot(dirname(fileURLToPath(import.meta.url)))
  if (repositoryRoot !== null) {
    const relativePath = relative(repositoryRoot, filePath)
    if (relativePath.length > 0 && !relativePath.startsWith('..') && !isAbsolute(relativePath)) {
      return relativePath
    }
  }
  return basename(filePath)
}
