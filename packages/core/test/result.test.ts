import { describe, expect, it } from 'vitest'

import { createDomainError } from '../src/index.js'
import type { Result } from '../src/index.js'

// テストは合成データのみを使う（Secret・実データは扱わない）。

describe('createDomainError', () => {
  it('再試行可能な分類には retryable=true を付ける', () => {
    expect(createDomainError('TEMPORARY_FAILURE')).toEqual({
      code: 'TEMPORARY_FAILURE',
      retryable: true,
    })
    expect(createDomainError('REFRESH_NOT_ACCEPTED').retryable).toBe(true)
    expect(createDomainError('UNKNOWN').retryable).toBe(true)
  })

  it('再試行しても回復しない分類には retryable=false を付ける', () => {
    expect(createDomainError('AUTH_REQUIRED')).toEqual({
      code: 'AUTH_REQUIRED',
      retryable: false,
    })
    expect(createDomainError('SECRET_NOT_FOUND').retryable).toBe(false)
    expect(createDomainError('SECRET_INVALID').retryable).toBe(false)
    expect(createDomainError('ACCESS_DENIED').retryable).toBe(false)
  })

  it('分類と再試行可否以外の field を持たない（message 等の自由文字列は持たない）', () => {
    expect(Object.keys(createDomainError('UNKNOWN'))).toEqual(['code', 'retryable'])
  })
})

describe('Result', () => {
  it('ok の真偽で value / error に判別できる', () => {
    const success: Result<number> = { ok: true, value: 1 }
    const failure: Result<number> = { ok: false, error: createDomainError('UNKNOWN') }

    expect(success.ok ? success.value : undefined).toBe(1)
    expect(failure.ok ? undefined : failure.error.code).toBe('UNKNOWN')
  })
})
