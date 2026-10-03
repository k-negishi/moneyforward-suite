import type { ApplicationResult, AuthSession, RefreshAccountsInput, Result } from '@mf-suite/core'
import { createDomainError } from '@mf-suite/core'
import { describe, expect, it } from 'vitest'
import type { RefreshAccountsExecutor } from '../src/handler.js'
import { createAutomationHandler } from '../src/handler.js'
import type { SessionProvider } from '../src/session-provider.js'

/**
 * Automation Handler の検証。Job 名 → 実行担当の対応表と Session Provider を fake に差し替え、
 * status / errorCode がそのまま透過すること（業務判断を再実装しないこと）、
 * 入力拒否・セッション取得失敗・例外が安全側へ写ること、出力に機密が現れないことを固定する。
 */

// セッションの中身と例外メッセージに漏えい検知用の目印を入れ、どの出力経路にも現れないことを検査する。
const SESSION_MARKER = 'SYNTHETIC_SESSION_MUST_NOT_LEAK'
const ERROR_MARKER = 'SYNTHETIC_ERROR_MUST_NOT_LEAK'
const SYNTHETIC_SESSION = { marker: SESSION_MARKER } as unknown as AuthSession

/** 実行入力を記録する fake Use Case。返り値・例外をテストごとに指定する。 */
interface RecordingExecutor extends RefreshAccountsExecutor {
  readonly inputs: readonly RefreshAccountsInput[]
}

const createExecutor = (
  handle: (input: RefreshAccountsInput) => Promise<ApplicationResult>,
): RecordingExecutor => {
  const inputs: RefreshAccountsInput[] = []
  return {
    inputs,
    execute(input: RefreshAccountsInput): Promise<ApplicationResult> {
      inputs.push(input)
      return handle(input)
    },
  }
}

/** 呼び出し回数を記録する fake Session Provider。 */
interface RecordingSessionProvider {
  readonly provider: SessionProvider
  readonly callCount: () => number
}

const createSessionProvider = (
  handle: () => Promise<Result<AuthSession>>,
): RecordingSessionProvider => {
  let calls = 0
  return {
    provider: () => {
      calls += 1
      return handle()
    },
    callCount: () => calls,
  }
}

const resolveSession = (): Promise<Result<AuthSession>> =>
  Promise.resolve({ ok: true, value: SYNTHETIC_SESSION })

const failSession = (code: 'SESSION_MISSING' | 'SESSION_INVALID'): Promise<Result<AuthSession>> =>
  Promise.resolve({ ok: false, error: createDomainError(code) })

const VALID_EVENT = { job: 'refresh-accounts' } as const

describe('Automation Handler', () => {
  it('Use Case の status をそのまま返す', async () => {
    const executor = createExecutor(() => Promise.resolve({ status: 'SUCCESS' }))
    const session = createSessionProvider(resolveSession)
    const handler = createAutomationHandler({
      executors: { 'refresh-accounts': executor },
      sessionProvider: session.provider,
    })

    await expect(handler(VALID_EVENT)).resolves.toEqual({ status: 'SUCCESS' })
  })

  it('部分成功を失敗へ潰さずそのまま返す', async () => {
    const executor = createExecutor(() => Promise.resolve({ status: 'PARTIAL_SUCCESS' }))
    const session = createSessionProvider(resolveSession)
    const handler = createAutomationHandler({
      executors: { 'refresh-accounts': executor },
      sessionProvider: session.provider,
    })

    await expect(handler(VALID_EVENT)).resolves.toEqual({ status: 'PARTIAL_SUCCESS' })
  })

  it('FAILURE の errorCode をそのまま返す', async () => {
    const executor = createExecutor(() =>
      Promise.resolve({ status: 'FAILURE', errorCode: 'AUTH_REQUIRED' }),
    )
    const session = createSessionProvider(resolveSession)
    const handler = createAutomationHandler({
      executors: { 'refresh-accounts': executor },
      sessionProvider: session.provider,
    })

    await expect(handler(VALID_EVENT)).resolves.toEqual({
      status: 'FAILURE',
      errorCode: 'AUTH_REQUIRED',
    })
  })

  it('attempt を省略した入力を初回（1）として Use Case へ渡す', async () => {
    const executor = createExecutor(() => Promise.resolve({ status: 'SUCCESS' }))
    const session = createSessionProvider(resolveSession)
    const handler = createAutomationHandler({
      executors: { 'refresh-accounts': executor },
      sessionProvider: session.provider,
    })

    await handler(VALID_EVENT)

    expect(executor.inputs).toHaveLength(1)
    expect(executor.inputs[0]?.attempt).toBe(1)
    expect(executor.inputs[0]?.session).toBe(SYNTHETIC_SESSION)
  })

  it('attempt の明示値（2）を Use Case へ渡す', async () => {
    const executor = createExecutor(() => Promise.resolve({ status: 'SUCCESS' }))
    const session = createSessionProvider(resolveSession)
    const handler = createAutomationHandler({
      executors: { 'refresh-accounts': executor },
      sessionProvider: session.provider,
    })

    await handler({ job: 'refresh-accounts', attempt: 2 })

    expect(executor.inputs[0]?.attempt).toBe(2)
  })

  it('不正な Job は実行前に拒否し、Use Case とセッション取得を呼ばない', async () => {
    const executor = createExecutor(() => Promise.resolve({ status: 'SUCCESS' }))
    const session = createSessionProvider(resolveSession)
    const handler = createAutomationHandler({
      executors: { 'refresh-accounts': executor },
      sessionProvider: session.provider,
    })

    await expect(handler({ job: 'unknown-job', url: 'https://example.invalid/' })).resolves.toEqual(
      { status: 'FAILURE', errorCode: 'INVALID_JOB' },
    )
    expect(executor.inputs).toHaveLength(0)
    expect(session.callCount()).toBe(0)
  })

  it('セッション取得の失敗を分類のまま写し、Use Case を呼ばない', async () => {
    const executor = createExecutor(() => Promise.resolve({ status: 'SUCCESS' }))
    const session = createSessionProvider(() => failSession('SESSION_MISSING'))
    const handler = createAutomationHandler({
      executors: { 'refresh-accounts': executor },
      sessionProvider: session.provider,
    })

    await expect(handler(VALID_EVENT)).resolves.toEqual({
      status: 'FAILURE',
      errorCode: 'SESSION_MISSING',
    })
    expect(executor.inputs).toHaveLength(0)
  })

  it('Use Case の例外を UNKNOWN へ写し、例外メッセージを出力へ出さない', async () => {
    const executor = createExecutor(() => Promise.reject(new Error(ERROR_MARKER)))
    const session = createSessionProvider(resolveSession)
    const handler = createAutomationHandler({
      executors: { 'refresh-accounts': executor },
      sessionProvider: session.provider,
    })

    const result = await handler(VALID_EVENT)

    expect(result).toEqual({ status: 'FAILURE', errorCode: 'UNKNOWN' })
    expect(JSON.stringify(result)).not.toContain(ERROR_MARKER)
  })

  it('セッション取得の例外も UNKNOWN へ写し、例外メッセージを出力へ出さない', async () => {
    const executor = createExecutor(() => Promise.resolve({ status: 'SUCCESS' }))
    const session = createSessionProvider(() => Promise.reject(new Error(ERROR_MARKER)))
    const handler = createAutomationHandler({
      executors: { 'refresh-accounts': executor },
      sessionProvider: session.provider,
    })

    const result = await handler(VALID_EVENT)

    expect(result).toEqual({ status: 'FAILURE', errorCode: 'UNKNOWN' })
    expect(JSON.stringify(result)).not.toContain(ERROR_MARKER)
    expect(executor.inputs).toHaveLength(0)
  })

  it('出力は status と errorCode だけの契約で、セッションの内容を含まない', async () => {
    const executor = createExecutor(() => Promise.resolve({ status: 'SUCCESS' }))
    const session = createSessionProvider(resolveSession)
    const handler = createAutomationHandler({
      executors: { 'refresh-accounts': executor },
      sessionProvider: session.provider,
    })

    const result = await handler(VALID_EVENT)

    expect(Object.keys(result)).toEqual(['status'])
    expect(JSON.stringify(result)).not.toContain(SESSION_MARKER)
  })
})
