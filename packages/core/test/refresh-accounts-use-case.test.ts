import { expectTypeOf, describe, expect, it } from 'vitest'

import { RefreshAccountsUseCase, createDomainError } from '../src/index.js'
import type {
  ApplicationResult,
  AuthSession,
  LogEvent,
  LoggerPort,
  MoneyForwardPort,
  RefreshAccountsEvidence,
  RefreshAccountsInput,
  RefreshAccountsOutcome,
  RefreshAccountsUseCaseDependencies,
  Result,
  SessionVerification,
} from '../src/index.js'

// テストは合成データのみを使う（実サービス・実データ・行テキストは扱わない）。

/** ブランド付きのセッション値を作る（中身は Core が解釈しないため空の合成値でよい）。 */
const createSession = (): AuthSession => ({}) as AuthSession

/** 既定値付きの観測結果を作る（各テストは変更したい field だけを上書きする）。 */
const createOutcome = (
  overrides: Partial<Omit<RefreshAccountsOutcome, 'evidence'>> & {
    readonly evidence?: Partial<RefreshAccountsEvidence>
  } = {},
): RefreshAccountsOutcome => {
  const { evidence, ...rest } = overrides
  return {
    acceptance: 'ACCEPTED',
    evidence: {
      observedRowCount: 3,
      changedRowCount: 3,
      failedRowCount: 0,
      inProgressAppeared: false,
      ...evidence,
    },
    authLost: false,
    ...rest,
  }
}

/** 呼び出しを記録し、シナリオごとに戻り値を差し替えられる fake Port。 */
class FakeMoneyForwardPort implements MoneyForwardPort {
  verification: SessionVerification = 'VALID'
  refreshResult: Result<RefreshAccountsOutcome> = { ok: true, value: createOutcome() }
  readonly verifyCalls: AuthSession[] = []
  readonly refreshCalls: AuthSession[] = []

  async verifySession(session: AuthSession): Promise<SessionVerification> {
    this.verifyCalls.push(session)
    return this.verification
  }

  async refreshAccounts(session: AuthSession): Promise<Result<RefreshAccountsOutcome>> {
    this.refreshCalls.push(session)
    return this.refreshResult
  }
}

/** 記録されたイベントを捕捉する fake Logger。 */
class FakeLoggerPort implements LoggerPort {
  readonly events: LogEvent[] = []

  log(event: LogEvent): void {
    this.events.push(event)
  }
}

/** Use Case と fake Port を組み立てる。 */
const createHarness = () => {
  const moneyForward = new FakeMoneyForwardPort()
  const logger = new FakeLoggerPort()
  const useCase = new RefreshAccountsUseCase({ moneyForward, logger })
  return { useCase, moneyForward, logger }
}

/** イベントの field 名（ソート済み）。Allow List の検査に使う。 */
const fieldNames = (event: LogEvent): string[] => Object.keys(event).sort()

describe('RefreshAccountsUseCase', () => {
  describe('セッション検証（fail closed）', () => {
    it('認証要求を検知したら一括更新を試行せず、認証要求の失敗を返す', async () => {
      const { useCase, moneyForward } = createHarness()
      moneyForward.verification = 'AUTH_REQUIRED'
      const session = createSession()

      const result = await useCase.execute({ session, attempt: 1 })

      expect(result).toEqual({ status: 'FAILURE', errorCode: 'AUTH_REQUIRED' })
      expect(moneyForward.verifyCalls).toEqual([session])
      expect(moneyForward.refreshCalls).toHaveLength(0)
    })

    it('判定不能なら一時障害として fail closed で停止し、一括更新を試行しない', async () => {
      const { useCase, moneyForward } = createHarness()
      moneyForward.verification = 'UNKNOWN'

      const result = await useCase.execute({ session: createSession(), attempt: 1 })

      expect(result).toEqual({ status: 'FAILURE', errorCode: 'TEMPORARY_FAILURE' })
      expect(moneyForward.refreshCalls).toHaveLength(0)
    })

    it('検証の語彙外れの値（キャスト混入）も fail closed で停止し、一括更新を試行しない', async () => {
      const { useCase, moneyForward } = createHarness()
      // Adapter 境界で語彙外れの値がキャスト混入した場合を模す（停止側へ倒れることの回帰テスト）。
      moneyForward.verification = 'SESSION_EXPIRED' as unknown as SessionVerification

      const result = await useCase.execute({ session: createSession(), attempt: 1 })

      expect(result).toEqual({ status: 'FAILURE', errorCode: 'TEMPORARY_FAILURE' })
      expect(moneyForward.refreshCalls).toHaveLength(0)
    })
  })

  describe('受付・結果の写像', () => {
    it('受付が確認でき失敗行もなければ成功とし、検証済みの同じセッションで一括更新を 1 回呼ぶ', async () => {
      const { useCase, moneyForward } = createHarness()
      const session = createSession()
      moneyForward.refreshResult = { ok: true, value: createOutcome() }

      const result = await useCase.execute({ session, attempt: 1 })

      expect(result).toEqual({ status: 'SUCCESS' })
      expect(moneyForward.refreshCalls).toEqual([session])
    })

    it('一部の行だけが失敗した場合は部分成功とし、errorCode を持たない', async () => {
      const { useCase, moneyForward } = createHarness()
      moneyForward.refreshResult = {
        ok: true,
        value: createOutcome({ evidence: { changedRowCount: 2, failedRowCount: 1 } }),
      }

      const result = await useCase.execute({ session: createSession(), attempt: 1 })

      expect(result).toEqual({ status: 'PARTIAL_SUCCESS' })
      expect(Object.hasOwn(result, 'errorCode')).toBe(false)
    })

    it('受付が確認できず失敗の観測があれば、明示的な拒否として失敗にする', async () => {
      const { useCase, moneyForward } = createHarness()
      moneyForward.refreshResult = {
        ok: true,
        value: createOutcome({
          acceptance: 'NOT_ACCEPTED',
          evidence: { changedRowCount: 0, failedRowCount: 2 },
        }),
      }

      const result = await useCase.execute({ session: createSession(), attempt: 1 })

      expect(result).toEqual({ status: 'FAILURE', errorCode: 'REFRESH_REJECTED' })
    })

    it('受付が確認できず失敗の観測もなければ、受付確認不能として失敗にする', async () => {
      const { useCase, moneyForward } = createHarness()
      moneyForward.refreshResult = {
        ok: true,
        value: createOutcome({
          acceptance: 'NOT_ACCEPTED',
          evidence: { changedRowCount: 0, failedRowCount: 0 },
        }),
      }

      const result = await useCase.execute({ session: createSession(), attempt: 1 })

      expect(result).toEqual({ status: 'FAILURE', errorCode: 'REFRESH_NOT_ACCEPTED' })
    })

    it('処理中のセッション失効は、受付の有無によらず認証要求として失敗にする', async () => {
      const { useCase, moneyForward } = createHarness()
      moneyForward.refreshResult = { ok: true, value: createOutcome({ authLost: true }) }

      const result = await useCase.execute({ session: createSession(), attempt: 1 })

      expect(result).toEqual({ status: 'FAILURE', errorCode: 'AUTH_REQUIRED' })
    })

    it('一括更新が失敗の Result を返したら、正準の写像で分類をそのまま失敗にする', async () => {
      const { useCase, moneyForward } = createHarness()
      moneyForward.refreshResult = { ok: false, error: createDomainError('TARGET_NOT_FOUND') }

      const result = await useCase.execute({ session: createSession(), attempt: 1 })

      expect(result).toEqual({ status: 'FAILURE', errorCode: 'TARGET_NOT_FOUND' })
    })
  })

  describe('再試行の制約（実行基盤へ委ねる）', () => {
    it('再試行可能な受付確認不能でも、Use Case 内部で再試行しない', async () => {
      const { useCase, moneyForward } = createHarness()
      moneyForward.refreshResult = {
        ok: true,
        value: createOutcome({ acceptance: 'NOT_ACCEPTED', evidence: { changedRowCount: 0 } }),
      }

      const result = await useCase.execute({ session: createSession(), attempt: 1 })

      expect(result).toEqual({ status: 'FAILURE', errorCode: 'REFRESH_NOT_ACCEPTED' })
      expect(moneyForward.refreshCalls).toHaveLength(1)
    })

    it('execute ごとの一括更新の呼び出しは高々 1 回', async () => {
      const { useCase, moneyForward } = createHarness()

      await useCase.execute({ session: createSession(), attempt: 1 })
      expect(moneyForward.refreshCalls).toHaveLength(1)

      await useCase.execute({ session: createSession(), attempt: 2 })
      expect(moneyForward.refreshCalls).toHaveLength(2)
    })
  })

  describe('ログ（Allow List）', () => {
    it('開始と完了の 2 件を記録し、attempt を写す', async () => {
      const { useCase, logger } = createHarness()

      await useCase.execute({ session: createSession(), attempt: 2 })

      expect(logger.events).toHaveLength(2)
      const [started, completed] = logger.events
      expect(started).toEqual({
        application: 'automation',
        job: 'refresh-accounts',
        status: 'STARTED',
        attempt: 2,
        durationMs: 0,
      })
      expect(completed.status).toBe('SUCCESS')
      expect(completed.attempt).toBe(2)
      expect(Number.isInteger(completed.durationMs)).toBe(true)
      expect(completed.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('一括更新を試行しない場合も、開始と完了の 2 件を記録する', async () => {
      const { useCase, moneyForward, logger } = createHarness()
      moneyForward.verification = 'UNKNOWN'

      await useCase.execute({ session: createSession(), attempt: 1 })

      expect(logger.events.map((event) => event.status)).toEqual(['STARTED', 'FAILURE'])
    })

    it('成功の完了ログは errorCode を持たない', async () => {
      const { useCase, logger } = createHarness()

      await useCase.execute({ session: createSession(), attempt: 1 })

      expect(Object.hasOwn(logger.events[1], 'errorCode')).toBe(false)
    })

    it('失敗の完了ログには errorCode を付ける', async () => {
      const { useCase, moneyForward, logger } = createHarness()
      moneyForward.verification = 'AUTH_REQUIRED'

      await useCase.execute({ session: createSession(), attempt: 3 })

      expect(logger.events).toHaveLength(2)
      expect(logger.events[1]).toMatchObject({
        status: 'FAILURE',
        attempt: 3,
        errorCode: 'AUTH_REQUIRED',
      })
    })

    it('ログの field は Allow List に固定され、余剰の field（自由文字列・機密）を持たない', async () => {
      const { useCase, moneyForward, logger } = createHarness()

      await useCase.execute({ session: createSession(), attempt: 1 })

      moneyForward.verification = 'AUTH_REQUIRED'
      await useCase.execute({ session: createSession(), attempt: 2 })

      expect(logger.events.map(fieldNames)).toEqual([
        ['application', 'attempt', 'durationMs', 'job', 'status'],
        ['application', 'attempt', 'durationMs', 'job', 'status'],
        ['application', 'attempt', 'durationMs', 'job', 'status'],
        ['application', 'attempt', 'durationMs', 'errorCode', 'job', 'status'],
      ])
    })
  })
})

describe('RefreshAccountsUseCase の型契約', () => {
  it('execute は入力を受け取り ApplicationResult を返す', () => {
    expectTypeOf<RefreshAccountsUseCase['execute']>().parameters.toEqualTypeOf<[RefreshAccountsInput]>()
    expectTypeOf<RefreshAccountsUseCase['execute']>().returns.toEqualTypeOf<
      Promise<ApplicationResult>
    >()
  })

  it('依存は Port 2 つだけ（Concrete Adapter を受け取らない）', () => {
    expectTypeOf<keyof RefreshAccountsUseCaseDependencies>().toEqualTypeOf<
      'moneyForward' | 'logger'
    >()
  })
})
