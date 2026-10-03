import { expectTypeOf, describe, it } from 'vitest'

import type {
  AuthSession,
  LogEvent,
  LoggerPort,
  MoneyForwardPort,
  RefreshAccountsOutcome,
  Result,
  SecretId,
  SecretStorePort,
  SecretValue,
  SessionVerification,
} from '../src/index.js'

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

  it('Allow List 外の field（自由文字列）は追加できない', () => {
    // 余剰プロパティのエラーは該当行に出るため、リテラルを 1 行で書き、抑止コメントの
    // 直後の行と一致させる。
    // @ts-expect-error message は Allow List にない
    const event: LogEvent = { application: 'automation', job: 'refresh-accounts', status: 'FAILURE', attempt: 1, durationMs: 10, message: 'failed' }
    void event
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
