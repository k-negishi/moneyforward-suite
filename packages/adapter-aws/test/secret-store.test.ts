import { inspect } from 'node:util'

import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import type { ErrorCode, Result, SecretId, SecretValue } from '@mf-suite/core'

import { AwsSecretsManagerSecretStore } from '../src/index.js'
import type { SecretsManagerClientLike } from '../src/index.js'

// テストは合成の Secret と fake client だけを使う（実 AWS へは接続しない）。
// Secret の値は「漏えい検知用の目印」として使い、失敗結果の直列化とすべての出力経路
// （console・標準出力・標準エラー）へ現れないことを検証する。
// 成功値は実行時には生の文字列のまま持ち回る（ブランドはファントム）ため、直列化すると値が現れる。
// Adapter は成功値を出力しないが、呼び出し側も成功値を直列化・ログ出力しない前提であり、
// その前提は負の対照テストで固定する。
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

/**
 * 出力引数を検査用の文字列へ直列化する。オブジェクトを String で '[object Object]' に
 * 潰すと、値が含まれていても見逃すため JSON 化して中身まで検査する。JSON 化できない値
 * （循環参照・undefined 等）は inspect で構造を残す。
 */
const stringifyOutputArg = (arg: unknown): string => {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`
  try {
    return JSON.stringify(arg) ?? inspect(arg)
  } catch {
    return inspect(arg)
  }
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

  it('Secret 識別子の前後の空白は生成時に取り除く', async () => {
    const fake = createFakeClient(() => ({ SecretString: SYNTHETIC_SECRET_VALUE }))

    await createStore({ client: fake.client, secretName: '  secret-a  ' }).getSecret(
      SYNTHETIC_SECRET_ID,
    )

    expect(fake.sentCommands.map(readSentSecretId)).toEqual(['secret-a'])
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
    // 権限・資格情報の不足や失効（恒久。資格情報を直さない限り再試行では回復しない）
    ['AccessDeniedException', 'ACCESS_DENIED'],
    ['UnrecognizedClientException', 'ACCESS_DENIED'],
    ['InvalidSignatureException', 'ACCESS_DENIED'],
    ['ExpiredTokenException', 'ACCESS_DENIED'],
    ['KMSAccessDeniedException', 'ACCESS_DENIED'],
    // Secret・KMS の構成や状態の問題（恒久。再試行では回復しない）
    ['InvalidParameterException', 'SECRET_INVALID'],
    ['InvalidRequestException', 'SECRET_INVALID'],
    ['PreconditionNotMetException', 'SECRET_INVALID'],
    ['DecryptionFailure', 'SECRET_INVALID'],
    ['EncryptionFailure', 'SECRET_INVALID'],
    // 一時障害（再試行で回復し得る。分類できない未知の例外もこの側へ倒す）
    ['ThrottlingException', 'TEMPORARY_FAILURE'],
    ['LimitExceededException', 'TEMPORARY_FAILURE'],
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

  it('取得した値・例外 message をログ・標準出力・標準エラーへ出さない', async () => {
    const consoleSpies = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'debug'),
    ]
    const stdoutSpy = vi.spyOn(process.stdout, 'write')
    const stderrSpy = vi.spyOn(process.stderr, 'write')

    let output = ''
    try {
      const succeeding = createFakeClient(() => ({ SecretString: SYNTHETIC_SECRET_VALUE }))
      await createStore({ client: succeeding.client }).getSecret(SYNTHETIC_SECRET_ID)

      const failing = createFakeClient(() => {
        throw Object.assign(new Error(`合成の例外メッセージ: ${SYNTHETIC_SECRET_VALUE}`), {
          name: 'AccessDeniedException',
        })
      })
      await createStore({ client: failing.client }).getSecret(SYNTHETIC_SECRET_ID)

      // 記録は mockRestore で消えるため、復元の前に出力内容を取り出す。
      // 引数は stringifyOutputArg で中身まで直列化する（String ではオブジェクトが
      // '[object Object]' に潰れ、値が含まれていても見逃すため）。
      output = [
        ...consoleSpies.flatMap((spy) => spy.mock.calls),
        ...stdoutSpy.mock.calls,
        ...stderrSpy.mock.calls,
      ]
        .flat()
        .map(stringifyOutputArg)
        .join('\n')
    } finally {
      vi.restoreAllMocks()
    }

    expect(output).not.toContain(SYNTHETIC_SECRET_VALUE)
    expect(output).not.toContain('合成の例外メッセージ')
  })

  it('成功値は実行時には生の文字列であり、直列化すると現れる（呼び出し側で出力しない前提の負の対照）', async () => {
    const fake = createFakeClient(() => ({ SecretString: SYNTHETIC_SECRET_VALUE }))

    const result = await createStore({ client: fake.client }).getSecret(SYNTHETIC_SECRET_ID)

    if (!result.ok) throw new Error(`成功を期待したが失敗した: ${result.error.code}`)
    // ブランドはファントムのため、実行時の値は生の文字列である。
    expect(typeof result.value).toBe('string')
    // したがって成功結果を直列化すると値が現れる。呼び出し側は成功値を直列化・ログ出力しない
    // （この前提を負の対照として固定し、失敗結果側の非漏えいテストと対にする）。
    expect(JSON.stringify(result)).toContain(SYNTHETIC_SECRET_VALUE)
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
