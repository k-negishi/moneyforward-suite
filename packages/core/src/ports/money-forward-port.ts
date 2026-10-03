import type { RefreshAccountsOutcome } from '../domain/refresh-accounts.js'
import type { Result } from '../result.js'

declare const authSessionBrand: unique symbol

/**
 * MoneyForward ME の認証セッション（opaque）。
 * 中身（storageState 等の Secret）を Core は知らない。生成・保存・検証はセキュリティ側、
 * 消費（ブラウザへの適用）は Adapter の責務とし、Core は値を持ち回るだけにする。
 */
export type AuthSession = { readonly [authSessionBrand]: 'AuthSession' }

/** セッション検証の三値。UNKNOWN は判定不能を表し、呼び出し側は fail closed で停止する。 */
export type SessionVerification = 'VALID' | 'AUTH_REQUIRED' | 'UNKNOWN'

/**
 * MoneyForward ME を操作する能力（外部 Capability 単位の Port）。
 * 操作は「セッションの検証」と「一括更新の実行」に絞り、UI の手順（ページ遷移・クリック・
 * 待機）は Adapter の内部に閉じる。
 */
export interface MoneyForwardPort {
  /** セッションの有効性を検証する。 */
  verifySession(session: AuthSession): Promise<SessionVerification>
  /** 金融機関のデータ一括更新を実行し、受付・結果の観測値を返す。 */
  refreshAccounts(session: AuthSession): Promise<Result<RefreshAccountsOutcome>>
}
