import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createSecretsManagerClient } from '../src/secrets-manager/client.js'
import { createSecretId } from '../src/secrets-manager/secret-store.js'

/**
 * client ファクトリの検証。AWS SDK の client 生成だけを mock に差し替え、実 AWS へ接続せずに
 * region の正規化（trim・空文字は未指定）と、返り値が Port の要求する send を満たすことを固定する。
 */

const sdk = vi.hoisted(() => ({ constructedWith: [] as unknown[] }))

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    constructor(options: unknown) {
      sdk.constructedWith.push(options)
    }

    send(): Promise<unknown> {
      return Promise.resolve({})
    }
  },
  // secret-store が import する名前も満たす（このテストでは使わない）。
  GetSecretValueCommand: class {
    readonly input: unknown

    constructor(input: unknown) {
      this.input = input
    }
  },
}))

describe('createSecretsManagerClient', () => {
  beforeEach(() => {
    sdk.constructedWith.length = 0
  })

  it('region の省略時は空の設定で生成し、SDK の既定解決に委ねる', () => {
    createSecretsManagerClient()

    expect(sdk.constructedWith).toEqual([{}])
  })

  it('region は前後の空白を除去して SDK へ渡す', () => {
    createSecretsManagerClient({ region: '  ap-northeast-1  ' })

    expect(sdk.constructedWith).toEqual([{ region: 'ap-northeast-1' }])
  })

  it('空文字・空白のみの region は未指定として扱う', () => {
    createSecretsManagerClient({ region: '' })
    createSecretsManagerClient({ region: '   ' })

    expect(sdk.constructedWith).toEqual([{}, {}])
  })

  it('生成した client は send を持つ', () => {
    expect(typeof createSecretsManagerClient().send).toBe('function')
  })
})

describe('createSecretId', () => {
  it('物理名をそのまま論理 ID として扱う（実行時は文字列）', () => {
    const secretId = createSecretId('synthetic-session-secret')

    expect(secretId as unknown as string).toBe('synthetic-session-secret')
  })
})
