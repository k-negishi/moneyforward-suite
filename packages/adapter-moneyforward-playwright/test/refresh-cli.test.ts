import { describe, expect, it } from 'vitest'
import type { SpikeStatus } from '../src/cli/refresh-cli.js'
import { EXIT_CODE_BY_STATUS, parseRefreshArgs, toSpikeStatus } from '../src/cli/refresh-cli.js'
import type { RefreshObservation } from '../src/moneyforward/page-client.js'

// CLI の引数と終了コードの契約を固定する（既定の反転・矛盾指定の見逃しを検出する）。
describe('parseRefreshArgs', () => {
  it('引数なしは headless・読み取りのみ（--execute なし）', () => {
    expect(parseRefreshArgs([])).toEqual({ headless: true, execute: false })
  })

  it('--headed で表示モードになる', () => {
    expect(parseRefreshArgs(['--headed'])).toEqual({ headless: false, execute: false })
  })

  it('--headless で非表示モードになる', () => {
    expect(parseRefreshArgs(['--headless'])).toEqual({ headless: true, execute: false })
  })

  it('--execute で実行フラグが立つ', () => {
    expect(parseRefreshArgs(['--execute'])).toEqual({ headless: true, execute: true })
  })

  it('--headed と --execute の併用を受理する', () => {
    expect(parseRefreshArgs(['--headed', '--execute'])).toEqual({
      headless: false,
      execute: true,
    })
  })

  it('--headed と --headless の矛盾する同時指定は null を返す（順序によらない）', () => {
    expect(parseRefreshArgs(['--headed', '--headless'])).toBeNull()
    expect(parseRefreshArgs(['--headless', '--headed'])).toBeNull()
  })

  it('未知の引数は null を返す', () => {
    expect(parseRefreshArgs(['--bogus'])).toBeNull()
    expect(parseRefreshArgs(['headed'])).toBeNull()
    expect(parseRefreshArgs(['--execute=1'])).toBeNull()
    expect(parseRefreshArgs(['--headless', 'https://example.invalid/'])).toBeNull()
  })

  it('同じオプションの重複指定は同じ結果になる（最後の指定に引きずられない）', () => {
    expect(parseRefreshArgs(['--headed', '--headed'])).toEqual({ headless: false, execute: false })
    expect(parseRefreshArgs(['--headless', '--headless'])).toEqual({
      headless: true,
      execute: false,
    })
    expect(parseRefreshArgs(['--execute', '--execute'])).toEqual({
      headless: true,
      execute: true,
    })
  })
})

describe('EXIT_CODE_BY_STATUS', () => {
  it('すべての状態に終了コードを定義する（判定成功 = 0、一部成功 = 4、認証が必要 = 2、その他 = 1）', () => {
    expect(Object.keys(EXIT_CODE_BY_STATUS).sort((a, b) => a.localeCompare(b))).toEqual(
      [
        'AUTH_REQUIRED',
        'REFRESH_ACCEPTED',
        'REFRESH_AVAILABLE',
        'REFRESH_PARTIAL',
        'SESSION_INVALID',
        'SESSION_MISSING',
        'TARGET_AMBIGUOUS',
        'TARGET_NOT_FOUND',
        'TEMPORARY_FAILURE',
      ].sort((a, b) => a.localeCompare(b)),
    )
  })

  it('判定成功（REFRESH_AVAILABLE / REFRESH_ACCEPTED）は 0', () => {
    expect(EXIT_CODE_BY_STATUS.REFRESH_AVAILABLE).toBe(0)
    expect(EXIT_CODE_BY_STATUS.REFRESH_ACCEPTED).toBe(0)
  })

  it('部分成功（REFRESH_PARTIAL）は 4（正式 CLI の PARTIAL_SUCCESS に対応）', () => {
    expect(EXIT_CODE_BY_STATUS.REFRESH_PARTIAL).toBe(4)
  })

  it('AUTH_REQUIRED は 2', () => {
    expect(EXIT_CODE_BY_STATUS.AUTH_REQUIRED).toBe(2)
  })

  it('停止系（セッション・対象・一時障害）は 1（fail closed）', () => {
    const nonZeroStatuses: SpikeStatus[] = [
      'SESSION_MISSING',
      'SESSION_INVALID',
      'TARGET_NOT_FOUND',
      'TARGET_AMBIGUOUS',
      'TEMPORARY_FAILURE',
    ]

    for (const status of nonZeroStatuses) {
      expect(EXIT_CODE_BY_STATUS[status]).toBe(1)
    }
  })
})

describe('toSpikeStatus', () => {
  const observation: RefreshObservation = {
    acceptance: 'ACCEPTED',
    observedRowCount: 2,
    changedRowCount: 1,
    failedRowCount: 0,
    inProgressAppeared: false,
    authLost: false,
  }

  it('AVAILABLE → REFRESH_AVAILABLE（読み取りのみの確認成功）', () => {
    expect(toSpikeStatus({ status: 'AVAILABLE' })).toBe('REFRESH_AVAILABLE')
  })

  it('受付が確認できた観測（失敗行なし）→ REFRESH_ACCEPTED / 終了コード 0', () => {
    const status = toSpikeStatus({ status: 'OBSERVED', observation })
    expect(status).toBe('REFRESH_ACCEPTED')
    expect(EXIT_CODE_BY_STATUS[status]).toBe(0)
  })

  it('一部の行が失敗した受付 → REFRESH_PARTIAL / 終了コード 4（成功表示へ潰さない）', () => {
    const status = toSpikeStatus({
      status: 'OBSERVED',
      observation: { ...observation, changedRowCount: 1, failedRowCount: 1 },
    })
    expect(status).toBe('REFRESH_PARTIAL')
    expect(EXIT_CODE_BY_STATUS[status]).toBe(4)
  })

  it('受付が確認できない観測 → TEMPORARY_FAILURE（失敗行があっても部分成功にしない）', () => {
    expect(
      toSpikeStatus({
        status: 'OBSERVED',
        observation: {
          ...observation,
          acceptance: 'NOT_ACCEPTED',
          changedRowCount: 0,
          failedRowCount: 1,
        },
      }),
    ).toBe('TEMPORARY_FAILURE')
  })

  it('認証失効の観測 → AUTH_REQUIRED（受付の有無によらない）', () => {
    expect(
      toSpikeStatus({ status: 'OBSERVED', observation: { ...observation, authLost: true } }),
    ).toBe('AUTH_REQUIRED')
  })

  it.each([
    ['AUTH_REQUIRED'],
    ['SESSION_INVALID'],
    ['TARGET_NOT_FOUND'],
    ['TARGET_AMBIGUOUS'],
    ['TEMPORARY_FAILURE'],
  ] as const)('続行できない理由 %s はそのまま写す', (reason) => {
    expect(toSpikeStatus({ status: reason })).toBe(reason)
  })
})
