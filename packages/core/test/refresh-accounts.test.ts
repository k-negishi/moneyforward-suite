import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  ApplicationResult,
  ErrorCode,
  RefreshAcceptance,
  RefreshAccountsEvidence,
  RefreshAccountsOutcome,
} from '../src/index.js'
import {
  createDomainError,
  isRetryableErrorCode,
  toApplicationResult,
  toFailureResult,
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

  it('進行中シグナルの出現だけでも、受付が確認できていれば成功とする（完了確認ではない）', () => {
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
    expect(result.status).toBe('PARTIAL_SUCCESS')
  })

  it('受付が確認できず失敗の観測もなければ、受付確認不能として再試行可能な失敗にする', () => {
    const result = toApplicationResult(
      createOutcome({
        acceptance: 'NOT_ACCEPTED',
        evidence: { changedRowCount: 0, failedRowCount: 0 },
      }),
    )
    expect(result).toEqual({ status: 'FAILURE', errorCode: 'REFRESH_NOT_ACCEPTED' })
    expect(result.status === 'FAILURE' && isRetryableErrorCode(result.errorCode)).toBe(true)
  })

  it('受付が確認できず失敗の観測があれば、明示的な拒否として再試行しない失敗にする', () => {
    const result = toApplicationResult(
      createOutcome({
        acceptance: 'NOT_ACCEPTED',
        evidence: { changedRowCount: 0, failedRowCount: 2 },
      }),
    )
    expect(result).toEqual({ status: 'FAILURE', errorCode: 'REFRESH_REJECTED' })
    expect(result.status === 'FAILURE' && isRetryableErrorCode(result.errorCode)).toBe(false)
  })

  it('受付は ACCEPTED 以外（語彙外れの値を含む）を失敗側に倒し、合法値の写像は変えない', () => {
    // 合法値の回帰（反転しても ACCEPTED は成功、NOT_ACCEPTED は受付確認不能のまま）。
    expect(toApplicationResult(createOutcome({ acceptance: 'ACCEPTED' }))).toEqual({
      status: 'SUCCESS',
    })
    expect(toApplicationResult(createOutcome({ acceptance: 'NOT_ACCEPTED' }))).toEqual({
      status: 'FAILURE',
      errorCode: 'REFRESH_NOT_ACCEPTED',
    })

    // Adapter の語彙が増え、キャストで語彙外れの値が混入した場合を模す（fail closed の回帰テスト）。
    const forged = 'PENDING' as unknown as RefreshAcceptance
    expect(toApplicationResult(createOutcome({ acceptance: forged }))).toEqual({
      status: 'FAILURE',
      errorCode: 'REFRESH_NOT_ACCEPTED',
    })
    expect(
      toApplicationResult(createOutcome({ acceptance: forged, evidence: { failedRowCount: 1 } })),
    ).toEqual({ status: 'FAILURE', errorCode: 'REFRESH_REJECTED' })
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

describe('toFailureResult', () => {
  it('Domain Error を失敗の Application Result へ写像する（正準の写像）', () => {
    expect(toFailureResult(createDomainError('AUTH_REQUIRED'))).toEqual({
      status: 'FAILURE',
      errorCode: 'AUTH_REQUIRED',
    })
    expect(toFailureResult(createDomainError('TEMPORARY_FAILURE'))).toEqual({
      status: 'FAILURE',
      errorCode: 'TEMPORARY_FAILURE',
    })
  })
})

describe('ApplicationResult の型契約', () => {
  it('errorCode は FAILURE のときだけ持つ（判別 union）', () => {
    expectTypeOf<ApplicationResult>().toEqualTypeOf<
      | { readonly status: 'SUCCESS' | 'PARTIAL_SUCCESS' | 'NO_REFRESH_NEEDED' }
      | { readonly status: 'FAILURE'; readonly errorCode: ErrorCode }
    >()
  })

  it('成功の status に errorCode は付けられない', () => {
    // @ts-expect-error errorCode は FAILURE のときだけ持てる
    const invalid: ApplicationResult = { status: 'SUCCESS', errorCode: 'UNKNOWN' }
    void invalid
  })
})
