import { containsAuthChallenge } from './locators.js'
import { normalizeText } from './row-changes.js'

/**
 * 認証状態の分類に使う純関数。
 * ページから集めた観測値（URL・可視テキスト・認証入力欄の数）だけを入力に取り、
 * 未認証と判定不能を区別する。判定不能を認証済みと見なさない（fail closed）。
 */

/** 認証状態の分類に使う観測値（Page からの取得は呼び出し側で行う）。 */
export interface AuthStateSignals {
  readonly isSignInUrl: boolean
  readonly visibleText: string
  readonly visibleChallengeInputCount: number
}

/** 認証状態の三値。UNKNOWN は判定不能（本文取得失敗）を表し、呼び出し側が fail closed で扱う。 */
export type AuthState = 'AUTHENTICATED' | 'AUTH_REQUIRED' | 'UNKNOWN'

/**
 * 認証状態を分類する（純関数）。
 * sign_in へのリダイレクト、可視の認証入力欄、入力要求の文言のいずれかを検知したら AUTH_REQUIRED。
 * 本文テキストを取得できない場合は認証済みと見なさず、判定不能の UNKNOWN を返す（fail closed）。
 * 入力欄の有無は本文の取得可否より先に評価する（本文が空でも入力欄があれば未認証と言い切れる）。
 */
export const classifyAuthState = (signals: AuthStateSignals): AuthState => {
  // sign_in へのリダイレクトは、本文の取得可否によらず未認証と言い切れる。
  if (signals.isSignInUrl) {
    return 'AUTH_REQUIRED'
  }
  if (signals.visibleChallengeInputCount > 0) {
    return 'AUTH_REQUIRED'
  }
  if (normalizeText(signals.visibleText).length === 0) {
    return 'UNKNOWN'
  }
  return containsAuthChallenge(signals.visibleText) ? 'AUTH_REQUIRED' : 'AUTHENTICATED'
}

/** ログイン CLI が返し得る状態。 */
export type LoginStatus = 'SESSION_SAVED' | 'AUTH_REQUIRED' | 'TEMPORARY_FAILURE'

/**
 * 認証状態をログイン CLI の結果へ写す（純関数）。
 * 認証済みなら保存へ進み（SESSION_SAVED）、未認証は AUTH_REQUIRED、判定不能は
 * TEMPORARY_FAILURE とする（未認証・判定不能はどちらも保存しない。fail closed）。
 */
export const authStateToLoginStatus = (authState: AuthState): LoginStatus => {
  if (authState === 'AUTHENTICATED') {
    return 'SESSION_SAVED'
  }
  return authState === 'AUTH_REQUIRED' ? 'AUTH_REQUIRED' : 'TEMPORARY_FAILURE'
}
