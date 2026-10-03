import { describe, expect, it } from 'vitest'

import { toRefreshResult } from '../src/moneyforward/adapter.js'
import type { RefreshObservation } from '../src/moneyforward/page-client.js'

// 合成した観測値のみを使う（実際のサービスへは触れない）。
describe('toRefreshResult', () => {
  const observation: RefreshObservation = {
    acceptance: 'ACCEPTED',
    observedRowCount: 3,
    changedRowCount: 2,
    failedRowCount: 0,
    inProgressAppeared: true,
    authLost: false,
  }

  it('受付が確認できた観測は ok の RefreshAccountsOutcome へ写す', () => {
    expect(toRefreshResult({ status: 'OBSERVED', observation })).toEqual({
      ok: true,
      value: {
        acceptance: 'ACCEPTED',
        evidence: {
          observedRowCount: 3,
          changedRowCount: 2,
          failedRowCount: 0,
          inProgressAppeared: true,
        },
        authLost: false,
      },
    })
  })

  it('不受理の観測も ok のまま写す（失敗の分類は core の写像が行う）', () => {
    const notAccepted: RefreshObservation = {
      ...observation,
      acceptance: 'NOT_ACCEPTED',
      changedRowCount: 0,
      inProgressAppeared: false,
      failedRowCount: 1,
    }

    expect(toRefreshResult({ status: 'OBSERVED', observation: notAccepted })).toEqual({
      ok: true,
      value: {
        acceptance: 'NOT_ACCEPTED',
        evidence: {
          observedRowCount: 3,
          changedRowCount: 0,
          failedRowCount: 1,
          inProgressAppeared: false,
        },
        authLost: false,
      },
    })
  })

  it('認証失効の観測は authLost に載せて ok のまま写す（分類は core が最優先で行う）', () => {
    const authLost: RefreshObservation = {
      ...observation,
      acceptance: 'NOT_ACCEPTED',
      changedRowCount: 0,
      inProgressAppeared: false,
      authLost: true,
    }

    const result = toRefreshResult({ status: 'OBSERVED', observation: authLost })

    expect(result.ok && result.value.authLost).toBe(true)
  })

  it.each([
    ['AUTH_REQUIRED'],
    ['SESSION_INVALID'],
    ['TARGET_NOT_FOUND'],
    ['TARGET_AMBIGUOUS'],
    ['TEMPORARY_FAILURE'],
  ] as const)('続行できない理由 %s は Result.error へ写す', (reason) => {
    expect(toRefreshResult({ status: reason })).toEqual({
      ok: false,
      error: { code: reason },
    })
  })
})
