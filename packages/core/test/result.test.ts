import { describe, expect, it } from 'vitest'

import { createDomainError, isErrorCode, isRetryableErrorCode } from '../src/index.js'
import type { DomainError, ErrorCode, Result } from '../src/index.js'

// テストは合成データのみを使う（Secret・実データは扱わない）。

describe('createDomainError', () => {
  it('分類だけを持つ Domain Error を作る（再試行可否は対応表から導出する）', () => {
    expect(createDomainError('TEMPORARY_FAILURE')).toEqual({ code: 'TEMPORARY_FAILURE' })
    expect(createDomainError('AUTH_REQUIRED')).toEqual({ code: 'AUTH_REQUIRED' })
  })

  it('分類以外の field を持たない（message 等の自由文字列は持たない）', () => {
    expect(Object.keys(createDomainError('UNKNOWN'))).toEqual(['code'])
  })

  it('ブランドは型レベルのみで、実行時の形状は分類だけのまま', () => {
    expect(Object.getOwnPropertySymbols(createDomainError('UNKNOWN'))).toEqual([])
  })

  it('Domain Error はリテラルから直接構築できない（生成は createDomainError に強制）', () => {
    // @ts-expect-error ブランドを持つ型のため、リテラルからの直接構築は型エラーになる
    const forged: DomainError = { code: 'UNKNOWN' }
    void forged
  })

  it('キャストで語彙外の値が渡された場合は UNKNOWN へ丸める', () => {
    // Adapter 境界で生の文字列がキャストされる混入を模す（実行時の正規化の回帰テスト）。
    const forged = 'SECRET_LEAK' as unknown as ErrorCode
    expect(createDomainError(forged)).toEqual({ code: 'UNKNOWN' })
  })

  it('キャスト混入した語彙外の値は、生成と再試行可否の判断で同じ結果になる', () => {
    // 正規化の規則を 1 つに統一した回帰テスト。生成は UNKNOWN（再試行可）へ丸め、
    // 再試行可否の判断も同じ規則で UNKNOWN として扱う。
    const forged = 'SECRET_LEAK' as unknown as ErrorCode
    const error = createDomainError(forged)
    expect(error.code).toBe('UNKNOWN')
    expect(isRetryableErrorCode(forged)).toBe(true)
    expect(isRetryableErrorCode(error.code)).toBe(true)
  })

  it('キャスト混入した語彙内の値は、その分類のまま扱われる', () => {
    const forged = 'TEMPORARY_FAILURE' as unknown as ErrorCode
    expect(createDomainError(forged)).toEqual({ code: 'TEMPORARY_FAILURE' })
    expect(isRetryableErrorCode(forged)).toBe(true)
  })
})

describe('isErrorCode', () => {
  it('語彙に含まれる値だけを true と判定する', () => {
    expect(isErrorCode('TEMPORARY_FAILURE')).toBe(true)
    expect(isErrorCode('UNKNOWN')).toBe(true)
    expect(isErrorCode('SECRET_LEAK')).toBe(false)
    expect(isErrorCode('')).toBe(false)
    expect(isErrorCode(undefined)).toBe(false)
    expect(isErrorCode(42)).toBe(false)
    expect(isErrorCode({ code: 'UNKNOWN' })).toBe(false)
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
