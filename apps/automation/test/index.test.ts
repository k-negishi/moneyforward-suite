// apps/automation の公開 API（index.ts）の検証。handler / Job Router / Composition Root の公開面を
// ここから import し、Driving Adapter（Lambda エントリ・CLI）が組み立てに使う契約を固定する。
// 型 export は import して値として使うこと（型検査が通ること自体）で検証する。
import type { ApplicationResult } from '@mf-suite/core'
import { createDomainError } from '@mf-suite/core'
import { describe, expect, it } from 'vitest'
import type { AutomationHandler, JobExecutors } from '../src/index.js'
import {
  createAutomationHandler,
  createAwsAutomation,
  createLocalAutomation,
  createSecretStoreSessionProvider,
  createSessionFileProvider,
  routeJob,
} from '../src/index.js'

describe('apps/automation の公開 API', () => {
  it('Composition Root の組み立て関数を公開する', () => {
    expect(typeof createLocalAutomation).toBe('function')
    expect(typeof createAwsAutomation).toBe('function')
  })

  it('Job Router を公開し、許可 Job だけを受理する', () => {
    expect(routeJob({ job: 'refresh-accounts' })).toEqual({
      ok: true,
      value: { job: 'refresh-accounts', attempt: 1 },
    })

    const rejected = routeJob({ job: 'unknown-job' })
    if (rejected.ok) {
      throw new Error('拒否を期待したが受理された')
    }
    expect(rejected.error.code).toBe('INVALID_JOB')
  })

  it('Session Provider の組み立て関数を公開する', () => {
    expect(typeof createSessionFileProvider).toBe('function')
    expect(typeof createSecretStoreSessionProvider).toBe('function')
  })

  it('Handler を Job 名 → 実行担当の対応表から組み立てられる', async () => {
    const executors: JobExecutors = {
      'refresh-accounts': {
        execute: (): Promise<ApplicationResult> => Promise.resolve({ status: 'SUCCESS' }),
      },
    }
    const handler: AutomationHandler = createAutomationHandler({
      executors,
      sessionProvider: () =>
        Promise.resolve({ ok: false, error: createDomainError('SESSION_MISSING') }),
    })

    await expect(handler({ job: 'refresh-accounts' })).resolves.toEqual({
      status: 'FAILURE',
      errorCode: 'SESSION_MISSING',
    })
  })
})
