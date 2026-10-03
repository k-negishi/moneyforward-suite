import type { AuthSession } from '@mf-suite/core'

import type { SessionState } from './session-state.js'

/**
 * opaque な AuthSession と、セッション状態（Cookie と localStorage）の相互変換。
 * AuthSession のブランドは core の公開 API から export されないため、境界を跨ぐ構築・取り出しは
 * この変換に閉じる。構築（toAuthSession）はセッションを実際に永続化するこの package の責務、
 * 消費（fromAuthSession）はブラウザへ適用する Adapter の責務とし、この 2 つ以外に
 * セッションの中身へ触れる経路を作らない（ADR-0032）。
 */

/**
 * セッション状態を opaque な AuthSession へ包む。
 * この関数を通した値だけが Port（core）の契約を満たす。
 */
export const toAuthSession = (sessionState: SessionState): AuthSession =>
  sessionState as unknown as AuthSession

/**
 * opaque な AuthSession からセッション状態を取り出す。
 * 取り出した内容は Secret のため、ログ・エラー・標準出力へ出さない。
 */
export const fromAuthSession = (session: AuthSession): SessionState =>
  session as unknown as SessionState
