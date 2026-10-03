import { describe, expect, it } from 'vitest'

import { authStateToLoginStatus, classifyAuthState } from '../src/moneyforward/auth-state.js'

// 合成した文言のみを使う（本番の DOM / HTML は使わない）。
describe('classifyAuthState', () => {
  it('sign_in へリダイレクトされていれば AUTH_REQUIRED', () => {
    expect(
      classifyAuthState({
        isSignInUrl: true,
        visibleText: 'ログイン',
        visibleChallengeInputCount: 0,
      }),
    ).toBe('AUTH_REQUIRED')
  })

  it('本文テキストが取得できない場合は UNKNOWN（判定不能）', () => {
    expect(
      classifyAuthState({ isSignInUrl: false, visibleText: '', visibleChallengeInputCount: 0 }),
    ).toBe('UNKNOWN')
    expect(
      classifyAuthState({
        isSignInUrl: false,
        visibleText: ' \n ',
        visibleChallengeInputCount: 0,
      }),
    ).toBe('UNKNOWN')
  })

  it('認証チャレンジを検知したら AUTH_REQUIRED', () => {
    expect(
      classifyAuthState({
        isSignInUrl: false,
        visibleText: 'ワンタイムパスワードを入力してください',
        visibleChallengeInputCount: 1,
      }),
    ).toBe('AUTH_REQUIRED')
  })

  it('判定不能（空本文）よりも sign_in の判定を優先する', () => {
    expect(
      classifyAuthState({ isSignInUrl: true, visibleText: '', visibleChallengeInputCount: 0 }),
    ).toBe('AUTH_REQUIRED')
  })

  it('本文が取得できなくても、可視の認証入力欄があれば AUTH_REQUIRED（判定不能より優先する）', () => {
    expect(
      classifyAuthState({ isSignInUrl: false, visibleText: '', visibleChallengeInputCount: 1 }),
    ).toBe('AUTH_REQUIRED')
  })

  it('チャレンジも判定不能も無ければ AUTHENTICATED', () => {
    expect(
      classifyAuthState({
        isSignInUrl: false,
        visibleText: 'ようこそ MoneyForward ME へ',
        visibleChallengeInputCount: 0,
      }),
    ).toBe('AUTHENTICATED')
  })
})

describe('authStateToLoginStatus', () => {
  it.each([
    ['AUTHENTICATED', 'SESSION_SAVED'],
    ['AUTH_REQUIRED', 'AUTH_REQUIRED'],
    ['UNKNOWN', 'TEMPORARY_FAILURE'],
  ] as const)('%s → %s', (authState, expected) => {
    expect(authStateToLoginStatus(authState)).toBe(expected)
  })

  it('未認証・判定不能はどちらも保存へ進めない', () => {
    expect(authStateToLoginStatus('AUTH_REQUIRED')).not.toBe('SESSION_SAVED')
    expect(authStateToLoginStatus('UNKNOWN')).not.toBe('SESSION_SAVED')
  })
})
