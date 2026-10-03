import { beforeEach, describe, expect, it, vi } from 'vitest'

import { toAuthSession } from '@mf-suite/security'
import type { SessionState } from '@mf-suite/security'

import { PlaywrightMoneyForwardAdapter } from '../src/moneyforward/adapter.js'
import type { RefreshObservation } from '../src/moneyforward/page-client.js'

/**
 * ページ操作（page-client）だけを fake に差し替え、Port 経路
 * （AuthSession の復元 → checkSession / executeRefresh → Result への写像）を
 * ブラウザ・実サービスなしで駆動する。実装（adapter / page-client）には手を入れない。
 */
const pageClient = vi.hoisted(() => ({
  checkSession: vi.fn(),
  executeRefresh: vi.fn(),
}))

vi.mock('../src/moneyforward/page-client.js', () => ({
  checkSession: pageClient.checkSession,
  executeRefresh: pageClient.executeRefresh,
}))

// 合成した値のみを使う（実際の Cookie・セッショントークンは使わない）。
const syntheticSessionState: SessionState = {
  cookies: [
    {
      name: 'synthetic_cookie',
      value: 'synthetic_value',
      domain: 'example.invalid',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ],
  origins: [],
}

const syntheticObservation: RefreshObservation = {
  acceptance: 'ACCEPTED',
  observedRowCount: 2,
  changedRowCount: 1,
  failedRowCount: 0,
  inProgressAppeared: true,
  authLost: false,
}

describe('PlaywrightMoneyForwardAdapter の Port 経路', () => {
  beforeEach(() => {
    pageClient.checkSession.mockReset()
    pageClient.executeRefresh.mockReset()
  })

  it('verifySession は AuthSession を復元してページ操作へ渡し、例外は UNKNOWN へ写す', async () => {
    const adapter = new PlaywrightMoneyForwardAdapter({ headless: true })
    const session = toAuthSession(syntheticSessionState)

    pageClient.checkSession.mockResolvedValueOnce('VALID')

    await expect(adapter.verifySession(session)).resolves.toBe('VALID')
    expect(pageClient.checkSession).toHaveBeenCalledWith(syntheticSessionState, { headless: true })

    // 判定できない場合（例外）は停止側（UNKNOWN）へ倒す。
    pageClient.checkSession.mockRejectedValueOnce(new Error('合成した失敗'))

    await expect(adapter.verifySession(session)).resolves.toBe('UNKNOWN')
  })

  it('refreshAccounts は AuthSession を復元して実行し、観測は ok・例外は TEMPORARY_FAILURE へ写す', async () => {
    const adapter = new PlaywrightMoneyForwardAdapter({ headless: false })
    const session = toAuthSession(syntheticSessionState)

    pageClient.executeRefresh.mockResolvedValueOnce({
      status: 'OBSERVED',
      observation: syntheticObservation,
    })

    await expect(adapter.refreshAccounts(session)).resolves.toEqual({
      ok: true,
      value: {
        acceptance: 'ACCEPTED',
        evidence: {
          observedRowCount: 2,
          changedRowCount: 1,
          failedRowCount: 0,
          inProgressAppeared: true,
        },
        authLost: false,
      },
    })
    expect(pageClient.executeRefresh).toHaveBeenCalledWith(syntheticSessionState, {
      headless: false,
    })

    // 例外の内容は外へ出さず、再試行可能な一時障害として写す。
    pageClient.executeRefresh.mockRejectedValueOnce(new Error('合成した失敗'))

    await expect(adapter.refreshAccounts(session)).resolves.toEqual({
      ok: false,
      error: { code: 'TEMPORARY_FAILURE' },
    })
  })
})
