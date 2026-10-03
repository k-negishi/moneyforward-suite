/**
 * 認証セッションの中身（Cookie と localStorage）の型と構造検証。
 * Playwright の storageState の宣言型と互換の形に自前で定義する（この package は playwright に
 * 依存しない。Playwright の型への変換は Adapter 側の責務）。値は Cookie・セッショントークンを
 * 含む Secret のため、内容をログ・エラー・標準出力へ出さない（ADR-0011 / ADR-0013）。
 */

/** セッションに含まれる Cookie 1 件（Playwright の Cookie の宣言型と互換）。 */
export interface SessionCookie {
  readonly name: string
  readonly value: string
  readonly domain: string
  readonly path: string
  /** Unix time（秒）。 */
  readonly expires: number
  readonly httpOnly: boolean
  readonly secure: boolean
  readonly sameSite: 'Strict' | 'Lax' | 'None'
}

/** localStorage のエントリ 1 件（Playwright の localStorage の宣言型と互換）。 */
export interface SessionStorageEntry {
  readonly name: string
  readonly value: string
}

/** オリジンごとの localStorage（Playwright の origin の宣言型と互換）。 */
export interface SessionOrigin {
  readonly origin: string
  readonly localStorage: readonly SessionStorageEntry[]
}

/** 認証セッションの中身（Playwright の storageState の宣言型と互換）。 */
export interface SessionState {
  readonly cookies: readonly SessionCookie[]
  readonly origins: readonly SessionOrigin[]
}

/** 配列を含まないオブジェクトかどうか。 */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * セッション状態として最低限必要な形（cookies / origins がオブジェクトの配列）を満たすか。
 * 要素の中身までは検証しない（保存側の形式を前提にし、不一致は利用時に fail closed で扱う）。
 */
export const isSessionState = (value: unknown): value is SessionState => {
  if (!isPlainObject(value)) {
    return false
  }

  const { cookies, origins } = value
  return (
    Array.isArray(cookies) &&
    cookies.every(isPlainObject) &&
    Array.isArray(origins) &&
    origins.every(isPlainObject)
  )
}
