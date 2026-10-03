import type { SecretValue } from '@mf-suite/core'

import { describe, expect, it } from 'vitest'

import { parseSessionSecret } from '../src/session/session-secret.js'

/**
 * Secret（Secrets Manager の SecretString）からセッション状態を復元するパーサの検証。
 * セッションの形式知識を security に閉じ込め、Application が Secret の中身を解釈しないための境界。
 * 合成データだけを使い、実 Secret には触れない。
 */

/** 実行時の Secret 値（文字列）。ブランドはテスト側のキャストで作る。 */
const toSecretValue = (value: unknown): SecretValue => value as unknown as SecretValue

const SYNTHETIC_SESSION = {
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
  origins: [],
}

describe('parseSessionSecret', () => {
  it('セッション形式の JSON を復元する', () => {
    const result = parseSessionSecret(toSecretValue(JSON.stringify(SYNTHETIC_SESSION)))

    expect(result).toEqual({ status: 'OK', sessionState: SYNTHETIC_SESSION })
  })

  it('JSON として壊れている場合は SESSION_INVALID を返す', () => {
    expect(parseSessionSecret(toSecretValue('{"cookies": ['))).toEqual({
      status: 'SESSION_INVALID',
    })
  })

  it('JSON だがセッションの形でない場合は SESSION_INVALID を返す', () => {
    expect(parseSessionSecret(toSecretValue('{"other": true}'))).toEqual({
      status: 'SESSION_INVALID',
    })
    expect(parseSessionSecret(toSecretValue('{"cookies": {}, "origins": []}'))).toEqual({
      status: 'SESSION_INVALID',
    })
    expect(parseSessionSecret(toSecretValue('[]'))).toEqual({ status: 'SESSION_INVALID' })
  })

  it('空文字は SESSION_INVALID を返す', () => {
    expect(parseSessionSecret(toSecretValue(''))).toEqual({ status: 'SESSION_INVALID' })
  })

  it('文字列でない値は SESSION_INVALID を返す（外部境界の防御）', () => {
    expect(parseSessionSecret(toSecretValue({ cookies: [], origins: [] }))).toEqual({
      status: 'SESSION_INVALID',
    })
    expect(parseSessionSecret(toSecretValue(null))).toEqual({ status: 'SESSION_INVALID' })
  })
})
