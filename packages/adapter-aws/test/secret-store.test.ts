import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import type { ErrorCode, Result, SecretId, SecretValue } from '@mf-suite/core'

import { AwsSecretsManagerSecretStore } from '../src/index.js'
import type { SecretsManagerClientLike } from '../src/index.js'

// テストは合成の Secret と fake client だけを使う（実 AWS へは接続しない）。
// Secret の値は「漏えい検知用の目印」として使い、ログ・エラー・直列化へ現れないことを検証する。
const SYNTHETIC_SECRET_ID = 'synthetic/moneyforward-session' as unknown as SecretId
const SYNTHETIC_SECRET_NAME = 'synthetic-secret-name'
const SYNTHETIC_SECRET_VALUE = 'SYNTHETIC_SECRET_VALUE_MUST_NOT_LEAK'

interface FakeClient {
  readonly client: SecretsManagerClientLike
  readonly sentCommands: readonly unknown[]
}

/** 送信された command を記録し、指定された応答（または例外）を返す合成 client。 */
const createFakeClient = (handle: (command: unknown) => unknown): FakeClient => {
  const sentCommands: unknown[] = []
  return {
    sentCommands,
    client: {
      async send(command: unknown): Promise<unknown> {
        sentCommands.push(command)
        return handle(command)
      },
    },
  }
}

const createStore = (options: {
  readonly client: SecretsManagerClientLike
  readonly secretId?: SecretId
  readonly secretName?: string
}): AwsSecretsManagerSecretStore =>
  new AwsSecretsManagerSecretStore({
    secretId: options.secretId ?? SYNTHETIC_SECRET_ID,
    secretName: options.secretName ?? SYNTHETIC_SECRET_NAME,
    client: options.client,
  })

/** 送信された command が GetSecretValue で、その Secret 識別子を取り出す。 */
const readSentSecretId = (command: unknown): string | undefined =>
  command instanceof GetSecretValueCommand ? command.input.SecretId : undefined

/** 失敗を期待して分類を取り出す（成功した場合はテストを落とす）。 */
const expectFailure = (result: Result<SecretValue>): ErrorCode => {
  if (result.ok) throw new Error('失敗を期待したが成功した')
  return result.error.code
}

/** 成功を期待して値を取り出す（失敗した場合はテストを落とす）。 */
const readSecretValue = (result: Result<SecretValue>): string => {
  if (!result.ok) throw new Error(`成功を期待したが失敗した: ${result.error.code}`)
  // 値は opaque のため、合成データとの比較はテスト側のキャストで行う。
  return result.value as unknown as string
}

describe('AwsSecretsManagerSecretStore: 設定の注入', () => {
  it('GetSecretValue にはコンストラクタで設定した Secret 識別子を使う（コードへ固定しない）', async () => {
    const first = createFakeClient(() => ({ SecretString: SYNTHETIC_SECRET_VALUE }))
    const second = createFakeClient(() => ({ SecretString: SYNTHETIC_SECRET_VALUE }))

    await createStore({ client: first.client, secretName: 'secret-a' }).getSecret(
      SYNTHETIC_SECRET_ID,
    )
    await createStore({ client: second.client, secretName: 'secret-b' }).getSecret(
      SYNTHETIC_SECRET_ID,
    )

    expect(first.sentCommands).toHaveLength(1)
    expect(first.sentCommands[0]).toBeInstanceOf(GetSecretValueCommand)
    expect(first.sentCommands.map(readSentSecretId)).toEqual(['secret-a'])
    expect(second.sentCommands.map(readSentSecretId)).toEqual(['secret-b'])
  })

  it('Secret 識別子が空・空白だけの場合は生成時に停止する', () => {
    for (const secretName of ['', '   ']) {
      const fake = createFakeClient(() => ({}))
      expect(() => createStore({ client: fake.client, secretName })).toThrow()
    }
  })
})

describe('AwsSecretsManagerSecretStore: 正常系', () => {
  it('SecretString を取得し、ok と値で返す', async () => {
    const fake = createFakeClient(() => ({
      SecretString: SYNTHETIC_SECRET_VALUE,
      VersionId: 'synthetic-version',
    }))

    const result = await createStore({ client: fake.client }).getSecret(SYNTHETIC_SECRET_ID)

    expect(result.ok).toBe(true)
    expect(readSecretValue(result)).toBe(SYNTHETIC_SECRET_VALUE)
    expect(fake.sentCommands).toHaveLength(1)
  })
})

describe('AwsSecretsManagerSecretStore: 取得失敗の分類', () => {
  it.each([
    ['ResourceNotFoundException', 'SECRET_NOT_FOUND'],
    ['AccessDeniedException', 'ACCESS_DENIED'],
    ['ThrottlingException', 'TEMPORARY_FAILURE'],
    ['InternalServiceError', 'TEMPORARY_FAILURE'],
    ['TimeoutError', 'TEMPORARY_FAILURE'],
  ] as const)('例外 %s を %s へ写像する', async (name, expectedCode) => {
    const fake = createFakeClient(() => {
      throw Object.assign(new Error(`合成の例外メッセージ: ${SYNTHETIC_SECRET_VALUE}`), { name })
    })

    const result = await createStore({ client: fake.client }).getSecret(SYNTHETIC_SECRET_ID)

    expect(expectFailure(result)).toBe(expectedCode)
  })

  it('name を持たないネットワーク例外を TEMPORARY_FAILURE へ写像する', async () => {
    const fake = createFakeClient(() => {
      throw new TypeError('fetch failed')
    })

    const result = await createStore({ client: fake.client }).getSecret(SYNTHETIC_SECRET_ID)

    expect(expectFailure(result)).toBe('TEMPORARY_FAILURE')
  })

  it('例外以外が投げられても TEMPORARY_FAILURE へ写像する', async () => {
    const fake = createFakeClient(() => {
      throw 'synthetic-non-error'
    })

    const result = await createStore({ client: fake.client }).getSecret(SYNTHETIC_SECRET_ID)

    expect(expectFailure(result)).toBe('TEMPORARY_FAILURE')
  })

  it('設定と異なる Secret ID の要求は取得せずに SECRET_NOT_FOUND にする', async () => {
    const fake = createFakeClient(() => ({ SecretString: SYNTHETIC_SECRET_VALUE }))

    const result = await createStore({ client: fake.client }).getSecret(
      'another/secret' as unknown as SecretId,
    )

    expect(expectFailure(result)).toBe('SECRET_NOT_FOUND')
    expect(fake.sentCommands).toHaveLength(0)
  })
})

describe('AwsSecretsManagerSecretStore: 値の検証', () => {
  it.each([
    ['SecretString が空文字', { SecretString: '' }],
    ['SecretString が無い', { VersionId: 'synthetic-version' }],
    ['SecretBinary のみ', { SecretBinary: new Uint8Array([1, 2, 3]) }],
    ['応答が null', null],
    ['応答がオブジェクトでない', 'synthetic-response'],
  ])('%s の場合は SECRET_INVALID にする', async (_name, response) => {
    const fake = createFakeClient(() => response)

    const result = await createStore({ client: fake.client }).getSecret(SYNTHETIC_SECRET_ID)

    expect(expectFailure(result)).toBe('SECRET_INVALID')
  })
})

describe('AwsSecretsManagerSecretStore: Secret 値の非漏えい', () => {
  it('失敗結果は分類だけを持ち、例外 message・Secret 値を含まない', async () => {
    const fake = createFakeClient(() => {
      throw Object.assign(new Error(`合成の例外メッセージ: ${SYNTHETIC_SECRET_VALUE}`), {
        name: 'AccessDeniedException',
      })
    })

    const result = await createStore({ client: fake.client }).getSecret(SYNTHETIC_SECRET_ID)

    // 失敗結果の形を固定する（code 以外のフィールドを持てない）。
    expect(JSON.stringify(result)).toBe('{"ok":false,"error":{"code":"ACCESS_DENIED"}}')
    expect(JSON.stringify(result)).not.toContain(SYNTHETIC_SECRET_VALUE)
    expect(JSON.stringify(result)).not.toContain('合成の例外メッセージ')
  })

  it('取得した値・例外 message をログ・標準出力へ出さない', async () => {
    const consoleSpies = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'debug'),
    ]
    const stdoutSpy = vi.spyOn(process.stdout, 'write')

    let output = ''
    try {
      const succeeding = createFakeClient(() => ({ SecretString: SYNTHETIC_SECRET_VALUE }))
      await createStore({ client: succeeding.client }).getSecret(SYNTHETIC_SECRET_ID)

      const failing = createFakeClient(() => {
        throw Object.assign(new Error(SYNTHETIC_SECRET_VALUE), { name: 'AccessDeniedException' })
      })
      await createStore({ client: failing.client }).getSecret(SYNTHETIC_SECRET_ID)

      // 記録は mockRestore で消えるため、復元の前に出力内容を取り出す。
      output = [...consoleSpies.flatMap((spy) => spy.mock.calls), ...stdoutSpy.mock.calls]
        .flat()
        .map(String)
        .join('\n')
    } finally {
      vi.restoreAllMocks()
    }

    expect(output).not.toContain(SYNTHETIC_SECRET_VALUE)
  })
})

describe('AwsSecretsManagerSecretStore: 注入境界の型契約', () => {
  it('実 SecretsManagerClient を SecretsManagerClientLike として注入できる', () => {
    expectTypeOf<SecretsManagerClient>().toMatchTypeOf<SecretsManagerClientLike>()

    // 負の対照: send を持たない値は注入できない（型検査が効いていることの確認）
    // @ts-expect-error send を持たないため SecretsManagerClientLike ではない
    const notAClient: SecretsManagerClientLike = 'synthetic'
    void notAClient
  })
})
