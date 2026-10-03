import type { SessionState } from '@mf-suite/security'
import { describe, expect, it } from 'vitest'

import {
  buildContextOptions,
  buildLaunchOptions,
  toSessionState,
  toStorageState,
} from '../src/moneyforward/page-client.js'

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

  it('宣言に無いフィールドも往復で保持する（例: 分割 Cookie の partitionKey）', () => {
    // 保存ファイルは JSON のため、型宣言に無いフィールドも値として現れ得る。
    const storageState = JSON.parse(
      JSON.stringify({
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
            partitionKey: 'https://example.invalid',
          },
        ],
        origins: [
          {
            origin: 'https://example.invalid',
            localStorage: [{ name: 'synthetic_key', value: 'synthetic_value' }],
          },
        ],
      }),
    ) as Parameters<typeof toSessionState>[0]

    const roundTripped = toStorageState(toSessionState(storageState))

    expect(roundTripped).toEqual(storageState)
    expect(roundTripped.cookies[0]).toHaveProperty('partitionKey', 'https://example.invalid')
  })

  it('空のセッション状態も往復できる', () => {
    const empty: SessionState = { cookies: [], origins: [] }

    expect(toSessionState(toStorageState(empty))).toEqual(empty)
  })
})

// 起動・Context のオプションは builder だけが生成する。記録系のキーが混入しないことを
// キー集合で固定する（Artifact 非保存の二重防御。ADR-0017）。
describe('起動オプションの builder', () => {
  /** 記録系（Artifact 保存）のキー。存在したら保存物が作られ得る。 */
  const artifactOptionKeys = [
    'trace',
    'video',
    'screenshot',
    'recordHar',
    'recordVideo',
    'tracesDir',
  ] as const

  it('buildLaunchOptions は headless だけを生成する', () => {
    const options = buildLaunchOptions({ headless: true })

    expect(Object.keys(options)).toEqual(['headless'])
    expect(options).toEqual({ headless: true })
    expect(buildLaunchOptions({ headless: false })).toEqual({ headless: false })
  })

  it('buildContextOptions は storageState だけを生成する', () => {
    const options = buildContextOptions({ cookies: [], origins: [] })

    expect(Object.keys(options)).toEqual(['storageState'])
    expect(options.storageState).toEqual({ cookies: [], origins: [] })
  })

  it('セッション無しの buildContextOptions は空のオプションを生成する', () => {
    expect(Object.keys(buildContextOptions())).toEqual([])
    expect(buildContextOptions()).toEqual({})
  })

  it('生成されるオプションに記録系のキーが存在しない', () => {
    const launch = buildLaunchOptions({ headless: true })
    const context = buildContextOptions({
      cookies: [],
      origins: [],
    })

    for (const key of artifactOptionKeys) {
      expect(launch, `launch に ${key} が混入している`).not.toHaveProperty(key)
      expect(context, `context に ${key} が混入している`).not.toHaveProperty(key)
    }
  })
})
