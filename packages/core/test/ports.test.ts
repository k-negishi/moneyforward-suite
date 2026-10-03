import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  AuthSession,
  LogEvent,
  LoggerPort,
  LogStatus,
  MoneyForwardPort,
  RefreshAccountsOutcome,
  RefreshAccountsStatus,
  Result,
  SecretId,
  SecretStorePort,
  SecretValue,
  SessionVerification,
} from '../src/index.js'
import { isLogJob, isLogStatus } from '../src/index.js'

// Port の契約は expectTypeOf（コンパイル時の検査）で固定する。
// これにより Page / Locator 等の UI 詳細や自由文字列フィールドが型へ混入すると、
// 型検査（pnpm typecheck）が失敗する。実行時は合成データのみを使う。

describe('MoneyForwardPort の型契約', () => {
  it('verifySession は AuthSession を受け取り、三値の判定を返す', () => {
    expectTypeOf<MoneyForwardPort['verifySession']>().parameters.toEqualTypeOf<[AuthSession]>()
    expectTypeOf<MoneyForwardPort['verifySession']>().returns.toEqualTypeOf<
      Promise<SessionVerification>
    >()
    expectTypeOf<SessionVerification>().toEqualTypeOf<'VALID' | 'AUTH_REQUIRED' | 'UNKNOWN'>()
  })

  it('refreshAccounts は AuthSession を受け取り、Result<RefreshAccountsOutcome> を返す', () => {
    expectTypeOf<MoneyForwardPort['refreshAccounts']>().parameters.toEqualTypeOf<[AuthSession]>()
    expectTypeOf<MoneyForwardPort['refreshAccounts']>().returns.toEqualTypeOf<
      Promise<Result<RefreshAccountsOutcome>>
    >()
  })
})

describe('SecretStorePort の型契約', () => {
  it('getSecret は SecretId を受け取り、Result<SecretValue> を返す', () => {
    expectTypeOf<SecretStorePort['getSecret']>().parameters.toEqualTypeOf<[SecretId]>()
    expectTypeOf<SecretStorePort['getSecret']>().returns.toEqualTypeOf<
      Promise<Result<SecretValue>>
    >()
  })
})

describe('LoggerPort の型契約', () => {
  it('log は LogEvent を受け取り、同期で終わる', () => {
    expectTypeOf<LoggerPort['log']>().parameters.toEqualTypeOf<[LogEvent]>()
    expectTypeOf<LoggerPort['log']>().returns.toEqualTypeOf<void>()
  })

  it('LogEvent の field は Allow List に固定されている', () => {
    expectTypeOf<keyof LogEvent>().toEqualTypeOf<
      'application' | 'job' | 'status' | 'attempt' | 'durationMs' | 'errorCode'
    >()
  })

  it('job は refresh-accounts のリテラルに固定されている', () => {
    expectTypeOf<LogEvent['job']>().toEqualTypeOf<'refresh-accounts'>()
  })

  it('status は終状態に開始状態を加えた語彙に固定されている', () => {
    expectTypeOf<LogStatus>().toEqualTypeOf<RefreshAccountsStatus | 'STARTED'>()
    expectTypeOf<LogEvent['status']>().toEqualTypeOf<LogStatus>()
  })

  it('Allow List 外の field（自由文字列）は追加できない', () => {
    // 余剰プロパティのエラーは該当プロパティの行に出るため、抑止コメントを直前に置く。
    const event: LogEvent = {
      application: 'automation',
      job: 'refresh-accounts',
      status: 'FAILURE',
      attempt: 1,
      durationMs: 10,
      // @ts-expect-error message は Allow List にない
      message: 'failed',
    }
    void event
  })
})

describe('ログ語彙の実行時ガード', () => {
  it('isLogJob は語彙の値だけを受け入れ、型・大文字小文字・空白の揺れを拒否する', () => {
    expect(isLogJob('refresh-accounts')).toBe(true)

    for (const value of [
      'REFRESH_ACCOUNTS',
      'refresh_accounts',
      'refresh-accounts ',
      '',
      1,
      null,
      undefined,
      ['refresh-accounts'],
    ]) {
      expect(isLogJob(value), String(value)).toBe(false)
    }
  })

  it('isLogStatus は語彙の値だけを受け入れ、errorCode の語彙と混同しない', () => {
    for (const value of ['STARTED', 'SUCCESS', 'PARTIAL_SUCCESS', 'NO_REFRESH_NEEDED', 'FAILURE']) {
      expect(isLogStatus(value), value).toBe(true)
    }

    for (const value of ['started', 'UNKNOWN', 'AUTH_REQUIRED', '', 0, null, undefined]) {
      expect(isLogStatus(value), String(value)).toBe(false)
    }
  })
})

describe('opaque 型の境界', () => {
  it('AuthSession は文字列からは構築できない', () => {
    // @ts-expect-error AuthSession は opaque（生成・保存はセキュリティ側の責務）
    const session: AuthSession = '{"cookies":[]}'
    void session
  })

  it('SecretId は文字列からは構築できない', () => {
    // @ts-expect-error SecretId は opaque（実際の Secret 名への対応は Adapter 側の責務）
    const id: SecretId = 'moneyforward/session'
    void id
  })

  it('SecretValue は文字列からは構築できない', () => {
    // @ts-expect-error SecretValue は opaque（中身の解釈は Adapter 側の責務）
    const value: SecretValue = 'sensitive'
    void value
  })
})
