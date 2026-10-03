import { describe, expect, it } from 'vitest'

import { createSecretsManagerClient } from '../src/secrets-manager/client.js'
import { createSecretId } from '../src/secrets-manager/secret-store.js'

/**
 * AWS SDK 境界の最小検証。実 AWS へは接続せず（client の生成は通信を伴わない）、
 * 生成した client が Port の要求する send を持つことだけを固定する。
 * これにより apps 側は AWS SDK を import せずに実 client を組み立てられる。
 */

describe('createSecretsManagerClient', () => {
  it('region 省略でも send を持つ client を生成する', () => {
    const client = createSecretsManagerClient()

    expect(typeof client.send).toBe('function')
  })

  it('region を指定して client を生成する', () => {
    const client = createSecretsManagerClient({ region: 'us-east-1' })

    expect(typeof client.send).toBe('function')
  })
})

describe('createSecretId', () => {
  it('物理名をそのまま論理 ID として扱う（実行時は文字列）', () => {
    const secretId = createSecretId('synthetic-session-secret')

    expect(secretId as unknown as string).toBe('synthetic-session-secret')
  })
})
