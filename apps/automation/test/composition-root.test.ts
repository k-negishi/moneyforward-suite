import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SecretsManagerClientLike } from '@mf-suite/adapter-aws'
import { createSecretId } from '@mf-suite/adapter-aws'
import type {
  LogEvent,
  LoggerPort,
  MoneyForwardPort,
  RefreshAccountsOutcome,
  Result,
  SecretId,
  SecretStorePort,
  SecretValue,
  SessionVerification,
} from '@mf-suite/core'
import { createDomainError } from '@mf-suite/core'
import { SESSION_FILE_ENV_VAR } from '@mf-suite/security'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAwsAutomation, createLocalAutomation } from '../src/composition-root.js'

/**
 * Composition Root の検証。ローカル構成（セッションファイル）と AWS 構成（Secret Store）が、
 * fake Port の注入で組み上がることを固定する。実 AWS・実ブラウザには接続せず、
 * Secret とセッションは合成データだけを使う（実 Adapter の検証は各 Adapter のテストが担う）。
 */

const SECRET_NAME = 'synthetic-session-secret'
const SYNTHETIC_SESSION_STATE = {
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

/** セッションの一括更新が受理された観測結果（Use Case が SUCCESS へ写す）。 */
const ACCEPTED_OUTCOME: RefreshAccountsOutcome = {
  acceptance: 'ACCEPTED',
  evidence: {
    observedRowCount: 1,
    changedRowCount: 1,
    failedRowCount: 0,
    inProgressAppeared: false,
  },
  authLost: false,
}

/** 呼び出し回数を記録する fake MoneyForwardPort。 */
interface RecordingMoneyForward {
  readonly port: MoneyForwardPort
  readonly verifyCalls: () => number
  readonly refreshCalls: () => number
}

const createMoneyForward = (verification: SessionVerification = 'VALID'): RecordingMoneyForward => {
  let verifyCalls = 0
  let refreshCalls = 0
  return {
    port: {
      verifySession(): Promise<SessionVerification> {
        verifyCalls += 1
        return Promise.resolve(verification)
      },
      refreshAccounts(): Promise<Result<RefreshAccountsOutcome>> {
        refreshCalls += 1
        return Promise.resolve({ ok: true, value: ACCEPTED_OUTCOME })
      },
    },
    verifyCalls: () => verifyCalls,
    refreshCalls: () => refreshCalls,
  }
}

/** 記録する fake LoggerPort（構造化ロガーの代わりに注入し、allow-list field の写像を検査する）。 */
const createLogger = (): { readonly port: LoggerPort; readonly events: LogEvent[] } => {
  const events: LogEvent[] = []
  return { port: { log: (event) => events.push(event) }, events }
}

/** 呼び出された論理 Secret ID を記録する fake SecretStorePort。 */
const createSecretStore = (
  result: Result<SecretValue>,
): { readonly port: SecretStorePort; readonly requestedIds: SecretId[] } => {
  const requestedIds: SecretId[] = []
  return {
    port: {
      getSecret(secretId: SecretId): Promise<Result<SecretValue>> {
        requestedIds.push(secretId)
        return Promise.resolve(result)
      },
    },
    requestedIds,
  }
}

/** 送信された command を記録する fake Secrets Manager client（Adapter の生成だけを実物にする）。 */
const createFakeSecretsClient = (
  handle: (command: unknown) => unknown,
): { readonly client: SecretsManagerClientLike; readonly sentCommands: unknown[] } => {
  const sentCommands: unknown[] = []
  return {
    sentCommands,
    client: {
      send(command: unknown): Promise<unknown> {
        sentCommands.push(command)
        return Promise.resolve(handle(command))
      },
    },
  }
}

/** 送信された command から GetSecretValue の SecretId（物理名）を取り出す。 */
const readSentSecretName = (command: unknown): unknown => {
  if (typeof command !== 'object' || command === null || !('input' in command)) {
    return undefined
  }
  const input = command.input
  if (typeof input !== 'object' || input === null || !('SecretId' in input)) {
    return undefined
  }
  return input.SecretId
}

/** Secret Store が返す Secret の値（実行時は文字列。ブランドはテスト側のキャストで作る）。 */
const toSecretValue = (value: string): SecretValue => value as unknown as SecretValue

describe('Composition Root', () => {
  let workDirectory: string

  beforeEach(() => {
    workDirectory = mkdtempSync(join(tmpdir(), 'mf-automation-test-'))
  })

  afterEach(() => {
    rmSync(workDirectory, { recursive: true, force: true })
  })

  /** 合成データのセッションファイルを 0600 で作る（権限検査を通す）。 */
  const writeSyntheticSessionFile = (content: string): string => {
    const filePath = join(workDirectory, 'session.json')
    writeFileSync(filePath, content, { mode: 0o600 })
    chmodSync(filePath, 0o600)
    return filePath
  }

  describe('ローカル構成', () => {
    it('セッションファイルを読み、Playwright 以外の Port を注入して Use Case を実行する', async () => {
      const filePath = writeSyntheticSessionFile(JSON.stringify(SYNTHETIC_SESSION_STATE))
      const moneyForward = createMoneyForward()
      const logger = createLogger()

      const handler = createLocalAutomation(
        { headless: false, sessionFilePath: filePath },
        { moneyForward: moneyForward.port, logger: logger.port },
      )

      await expect(handler({ job: 'refresh-accounts' })).resolves.toEqual({ status: 'SUCCESS' })
      expect(moneyForward.verifyCalls()).toBe(1)
      expect(moneyForward.refreshCalls()).toBe(1)
      expect(logger.events.map((event) => event.status)).toEqual(['STARTED', 'SUCCESS'])
      expect(logger.events.every((event) => event.application === 'automation')).toBe(true)
      expect(logger.events.every((event) => event.job === 'refresh-accounts')).toBe(true)
    })

    it('セッションファイルが無い場合は SESSION_MISSING で停止し、Adapter を呼ばない', async () => {
      const moneyForward = createMoneyForward()

      const handler = createLocalAutomation(
        { headless: false, sessionFilePath: join(workDirectory, 'not-created.json') },
        { moneyForward: moneyForward.port, logger: createLogger().port },
      )

      await expect(handler({ job: 'refresh-accounts' })).resolves.toEqual({
        status: 'FAILURE',
        errorCode: 'SESSION_MISSING',
      })
      expect(moneyForward.verifyCalls()).toBe(0)
      expect(moneyForward.refreshCalls()).toBe(0)
    })

    it('セッションファイルが壊れている場合は SESSION_INVALID で停止する', async () => {
      const filePath = writeSyntheticSessionFile('{"cookies": [')

      const handler = createLocalAutomation(
        { headless: false, sessionFilePath: filePath },
        { moneyForward: createMoneyForward().port, logger: createLogger().port },
      )

      await expect(handler({ job: 'refresh-accounts' })).resolves.toEqual({
        status: 'FAILURE',
        errorCode: 'SESSION_INVALID',
      })
    })

    it('パスの指定を省略した場合は security の既定解決（MF_SESSION_FILE）に従う', async () => {
      const filePath = writeSyntheticSessionFile(JSON.stringify(SYNTHETIC_SESSION_STATE))
      const previous = process.env[SESSION_FILE_ENV_VAR]
      process.env[SESSION_FILE_ENV_VAR] = filePath
      try {
        const handler = createLocalAutomation(
          { headless: false },
          { moneyForward: createMoneyForward().port, logger: createLogger().port },
        )

        await expect(handler({ job: 'refresh-accounts' })).resolves.toEqual({ status: 'SUCCESS' })
      } finally {
        // 空文字は「上書きなし」として扱われる（テスト後の環境を汚さない）。
        process.env[SESSION_FILE_ENV_VAR] = previous ?? ''
      }
    })
  })

  describe('AWS 構成', () => {
    it('Secret Store（Port を fake に差し替え）からセッションを取得して Use Case を実行する', async () => {
      const secretStore = createSecretStore({
        ok: true,
        value: toSecretValue(JSON.stringify(SYNTHETIC_SESSION_STATE)),
      })
      const moneyForward = createMoneyForward()

      const handler = createAwsAutomation(
        { secretName: SECRET_NAME },
        {
          moneyForward: moneyForward.port,
          logger: createLogger().port,
          secretStore: secretStore.port,
        },
      )

      await expect(handler({ job: 'refresh-accounts' })).resolves.toEqual({ status: 'SUCCESS' })
      expect(moneyForward.refreshCalls()).toBe(1)
      // 構成が生成した論理 ID をそのまま Store へ渡している（物理名から導出した値で照合される）。
      expect(secretStore.requestedIds).toEqual([createSecretId(SECRET_NAME)])
    })

    it('実 Adapter を fake client で組み立て、Secret の値からセッションを復元する', async () => {
      const secretsClient = createFakeSecretsClient(() => ({
        // biome-ignore lint/style/useNamingConvention: AWS SDK の応答契約（外部境界）の形をそのまま写す
        SecretString: JSON.stringify(SYNTHETIC_SESSION_STATE),
      }))
      const moneyForward = createMoneyForward()

      const handler = createAwsAutomation(
        { secretName: SECRET_NAME },
        {
          moneyForward: moneyForward.port,
          logger: createLogger().port,
          secretsClient: secretsClient.client,
        },
      )

      await expect(handler({ job: 'refresh-accounts' })).resolves.toEqual({ status: 'SUCCESS' })
      expect(readSentSecretName(secretsClient.sentCommands[0])).toBe(SECRET_NAME)
    })

    it('Secret が取得できない場合は Store の分類をそのまま写す', async () => {
      const secretsClient = createFakeSecretsClient(() => {
        throw Object.assign(new Error('synthetic'), { name: 'ResourceNotFoundException' })
      })
      const moneyForward = createMoneyForward()

      const handler = createAwsAutomation(
        { secretName: SECRET_NAME },
        {
          moneyForward: moneyForward.port,
          logger: createLogger().port,
          secretsClient: secretsClient.client,
        },
      )

      await expect(handler({ job: 'refresh-accounts' })).resolves.toEqual({
        status: 'FAILURE',
        errorCode: 'SECRET_NOT_FOUND',
      })
      expect(moneyForward.verifyCalls()).toBe(0)
    })

    it('Secret の値がセッションの形式でない場合は SESSION_INVALID で停止する', async () => {
      const secretsClient = createFakeSecretsClient(() => ({
        // biome-ignore lint/style/useNamingConvention: AWS SDK の応答契約（外部境界）の形をそのまま写す
        SecretString: 'not a session',
      }))

      const handler = createAwsAutomation(
        { secretName: SECRET_NAME },
        {
          moneyForward: createMoneyForward().port,
          logger: createLogger().port,
          secretsClient: secretsClient.client,
        },
      )

      await expect(handler({ job: 'refresh-accounts' })).resolves.toEqual({
        status: 'FAILURE',
        errorCode: 'SESSION_INVALID',
      })
    })

    it('Session Provider の差し替えで取得元ごと fake にできる', async () => {
      const moneyForward = createMoneyForward()

      const handler = createAwsAutomation(
        { secretName: SECRET_NAME },
        {
          moneyForward: moneyForward.port,
          logger: createLogger().port,
          sessionProvider: () =>
            Promise.resolve({ ok: false, error: createDomainError('SESSION_MISSING') }),
        },
      )

      await expect(handler({ job: 'refresh-accounts' })).resolves.toEqual({
        status: 'FAILURE',
        errorCode: 'SESSION_MISSING',
      })
      expect(moneyForward.verifyCalls()).toBe(0)
    })
  })
})
