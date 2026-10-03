import { describe, expect, it } from 'vitest'

import { fromAuthSession, toAuthSession } from '../src/session/auth-session.js'
import type { SessionState } from '../src/session/session-state.js'

// 合成した値のみを使う（実際の Cookie・セッショントークンは使わない）。
describe('AuthSession との相互変換', () => {
  const syntheticSessionState: SessionState = {
    cookies: [
      {
        name: 'synthetic_cookie',
        value: 'synthetic_value',
        domain: 'example.invalid',
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ],
    origins: [
      {
        origin: 'https://example.invalid',
        localStorage: [{ name: 'synthetic_key', value: 'synthetic_value' }],
      },
    ],
  }

  it('toAuthSession → fromAuthSession で元のセッション状態に戻る', () => {
    expect(fromAuthSession(toAuthSession(syntheticSessionState))).toEqual(syntheticSessionState)
  })

  it('空のセッション状態も往復できる', () => {
    const empty: SessionState = { cookies: [], origins: [] }

    expect(fromAuthSession(toAuthSession(empty))).toEqual(empty)
  })
})
