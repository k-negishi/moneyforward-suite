import { describe, expect, it } from 'vitest'

import { toSessionState, toStorageState } from '../src/moneyforward/page-client.js'
import type { SessionState } from '@mf-suite/security'

// 合成した値のみを使う（実際の Cookie・セッショントークンは使わない）。
describe('セッション状態と Playwright storageState の相互変換', () => {
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

  it('toStorageState は storageState の形（cookies / origins）へ写す', () => {
    expect(toStorageState(syntheticSessionState)).toEqual({
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
    })
  })

  it('toSessionState → toStorageState の往復で内容が保たれる', () => {
    const storageState = toStorageState(syntheticSessionState)

    expect(toStorageState(toSessionState(storageState))).toEqual(storageState)
  })

  it('空のセッション状態も往復できる', () => {
    const empty: SessionState = { cookies: [], origins: [] }

    expect(toSessionState(toStorageState(empty))).toEqual(empty)
  })
})
