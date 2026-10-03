import { describe, expect, it } from 'vitest'

import { isRetryableErrorCode, toApplicationResult } from '../src/index.js'
import type {
  ErrorCode,
  RefreshAccountsEvidence,
  RefreshAccountsOutcome,
} from '../src/index.js'

// テストは合成データのみを使う（実サービス・実データ・行テキストは扱わない）。

/**
 * 再試行可否の期待値。ErrorCode の全語彙をキーにした Record にして、
 * 語彙が増えたときに対応表の分類漏れが型検査で検出されるようにする。
 */
const EXPECTED_RETRYABLE: Readonly<Record<ErrorCode, boolean>> = {
  AUTH_REQUIRED: false,
  SESSION_MISSING: false,
  SESSION_INVALID: false,
  INVALID_JOB: false,
  TARGET_NOT_FOUND: false,
  TARGET_AMBIGUOUS: false,
  REFRESH_REJECTED: false,
  REFRESH_NOT_ACCEPTED: true,
  TEMPORARY_FAILURE: true,
  SECRET_NOT_FOUND: false,
  SECRET_INVALID: false,
  ACCESS_DENIED: false,
  UNKNOWN: true,
}

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

describe('isRetryableErrorCode', () => {
  for (const [code, expected] of Object.entries(EXPECTED_RETRYABLE)) {
    it(`${code} の再試行可否は ${expected}`, () => {
      expect(isRetryableErrorCode(code as ErrorCode)).toBe(expected)
    })
  }
})

describe('toApplicationResult', () => {
  it('受付が確認でき、失敗行もなければ成功とする', () => {
    expect(toApplicationResult(createOutcome())).toEqual({ status: 'SUCCESS' })
  })

  it('進行中シグナルの出現だけでも、受付が確認できていれば成功とする', () => {
    expect(
      toApplicationResult(
        createOutcome({ evidence: { changedRowCount: 0, inProgressAppeared: true } }),
      ),
    ).toEqual({ status: 'SUCCESS' })
  })

  it('一部の行だけが失敗した場合は部分成功とし、errorCode を持たない', () => {
    const result = toApplicationResult(
      createOutcome({ evidence: { changedRowCount: 2, failedRowCount: 1 } }),
    )
    expect(result).toEqual({ status: 'PARTIAL_SUCCESS' })
    expect(result.errorCode).toBeUndefined()
  })

  it('受付が確認できず失敗の観測もなければ、受付確認不能として再試行可能な失敗にする', () => {
    const result = toApplicationResult(
      createOutcome({
        acceptance: 'NOT_ACCEPTED',
        evidence: { changedRowCount: 0, failedRowCount: 0 },
      }),
    )
    expect(result).toEqual({ status: 'FAILURE', errorCode: 'REFRESH_NOT_ACCEPTED' })
    expect(result.errorCode !== undefined && isRetryableErrorCode(result.errorCode)).toBe(true)
  })

  it('受付が確認できず失敗の観測があれば、明示的な拒否として再試行しない失敗にする', () => {
    const result = toApplicationResult(
      createOutcome({
        acceptance: 'NOT_ACCEPTED',
        evidence: { changedRowCount: 0, failedRowCount: 2 },
      }),
    )
    expect(result).toEqual({ status: 'FAILURE', errorCode: 'REFRESH_REJECTED' })
    expect(result.errorCode !== undefined && isRetryableErrorCode(result.errorCode)).toBe(false)
  })

  it('受付は確認できたが全ての行が失敗した場合は失敗とする', () => {
    expect(
      toApplicationResult(createOutcome({ evidence: { changedRowCount: 0, failedRowCount: 3 } })),
    ).toEqual({ status: 'FAILURE', errorCode: 'REFRESH_REJECTED' })
  })

  it('認証セッションの失効は受付の有無によらず認証要求として失敗にする', () => {
    expect(toApplicationResult(createOutcome({ authLost: true }))).toEqual({
      status: 'FAILURE',
      errorCode: 'AUTH_REQUIRED',
    })
    expect(
      toApplicationResult(
        createOutcome({
          acceptance: 'NOT_ACCEPTED',
          authLost: true,
          evidence: { changedRowCount: 0, failedRowCount: 2 },
        }),
      ),
    ).toEqual({ status: 'FAILURE', errorCode: 'AUTH_REQUIRED' })
    expect(toApplicationResult(createOutcome({ authLost: true })).errorCode).not.toBe(
      'REFRESH_NOT_ACCEPTED',
    )
  })

  it('NO_REFRESH_NEEDED は語彙のみで、写像では発火させない', () => {
    const outcomes = [
      createOutcome(),
      createOutcome({ evidence: { changedRowCount: 0, inProgressAppeared: true } }),
      createOutcome({ evidence: { changedRowCount: 2, failedRowCount: 1 } }),
      createOutcome({ acceptance: 'NOT_ACCEPTED' }),
      createOutcome({ acceptance: 'NOT_ACCEPTED', evidence: { failedRowCount: 1 } }),
      createOutcome({ evidence: { changedRowCount: 0, failedRowCount: 3 } }),
      createOutcome({ authLost: true }),
    ]
    const statuses = outcomes.map((outcome) => toApplicationResult(outcome).status)
    expect(statuses).not.toContain('NO_REFRESH_NEEDED')
  })
})
