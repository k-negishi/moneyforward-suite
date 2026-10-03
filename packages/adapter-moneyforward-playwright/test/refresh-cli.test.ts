import { describe, expect, it } from 'vitest'

import { EXIT_CODE_BY_STATUS, decideBulkStatus, parseRefreshArgs } from '../src/spike/refresh-cli.js'
import type { SpikeStatus } from '../src/spike/refresh-cli.js'

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
  it('すべての状態に終了コードを定義する（判定成功 = 0、認証が必要 = 2、その他 = 1）', () => {
    expect(Object.keys(EXIT_CODE_BY_STATUS).sort()).toEqual(
      [
        'AUTH_REQUIRED',
        'REFRESH_ACCEPTED',
        'REFRESH_AVAILABLE',
        'SESSION_INVALID',
        'SESSION_MISSING',
        'TARGET_AMBIGUOUS',
        'TARGET_NOT_FOUND',
        'TEMPORARY_FAILURE',
      ].sort(),
    )
  })

  it('判定成功（REFRESH_AVAILABLE / REFRESH_ACCEPTED）は 0', () => {
    expect(EXIT_CODE_BY_STATUS.REFRESH_AVAILABLE).toBe(0)
    expect(EXIT_CODE_BY_STATUS.REFRESH_ACCEPTED).toBe(0)
  })

  it('AUTH_REQUIRED は 2', () => {
    expect(EXIT_CODE_BY_STATUS.AUTH_REQUIRED).toBe(2)
  })

  it('それ以外は 1（fail closed）', () => {
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

describe('decideBulkStatus', () => {
  it.each([
    [true, true, 'REFRESH_ACCEPTED'],
    [true, false, 'TEMPORARY_FAILURE'],
    [false, true, 'TEMPORARY_FAILURE'],
    [false, false, 'TEMPORARY_FAILURE'],
  ] as const)('clicked=%s accepted=%s → %s', (clicked, accepted, expected) => {
    expect(decideBulkStatus({ clicked, accepted })).toBe(expected)
  })
})
