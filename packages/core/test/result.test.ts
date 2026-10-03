import { describe, expect, it } from 'vitest'

import { createDomainError, isRetryableErrorCode } from '../src/index.js'
import type { ErrorCode, Result } from '../src/index.js'

// テストは合成データのみを使う（Secret・実データは扱わない）。

describe('createDomainError', () => {
  it('分類だけを持つ Domain Error を作る（再試行可否は対応表から導出する）', () => {
    expect(createDomainError('TEMPORARY_FAILURE')).toEqual({ code: 'TEMPORARY_FAILURE' })
    expect(createDomainError('AUTH_REQUIRED')).toEqual({ code: 'AUTH_REQUIRED' })
  })

  it('分類以外の field を持たない（message 等の自由文字列は持たない）', () => {
    expect(Object.keys(createDomainError('UNKNOWN'))).toEqual(['code'])
  })

  it('キャストで語彙外の値が渡された場合は UNKNOWN へ丸める', () => {
    // Adapter 境界で生の文字列がキャストされる混入を模す（実行時の正規化の回帰テスト）。
    const forged = 'SECRET_LEAK' as unknown as ErrorCode
    expect(createDomainError(forged)).toEqual({ code: 'UNKNOWN' })
    expect(isRetryableErrorCode(forged)).toBe(false)
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
