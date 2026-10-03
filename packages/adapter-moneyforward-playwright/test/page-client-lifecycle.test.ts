import type { SessionState } from '@mf-suite/security'
import type { Browser, BrowserContextOptions, LaunchOptions, Route } from 'playwright'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  checkSession,
  executeRefresh,
  inspectRefreshTargets,
} from '../src/moneyforward/page-client.js'
import { accountRow, accountsHtml, CHANGE_TIMESTAMP_SCRIPT } from './synthetic-page.js'

/**
 * executeRefresh / checkSession / inspectRefreshTargets の外枠（起動・終了と例外の写像）のテスト。
 * 'playwright' をモックし、launch を実 chromium のままラップして次を行う:
 * ・newContext の直後に context.route を張り、通信を合成 HTML の fulfill に閉じる（実サービスへ到達させない）
 * ・起動した Browser を記録し、全経路で close されていることを実行時に確かめる
 * 合成 HTML は実 chromium が描画する。本番の HTML / DOM・実データは使わない。
 */

interface ShellState {
  routeHandler: ((route: Route) => Promise<void>) | null
  failNewContext: boolean
  launchedBrowsers: Browser[]
}

const shellState = vi.hoisted<ShellState>(() => ({
  routeHandler: null,
  failNewContext: false,
  launchedBrowsers: [],
}))

vi.mock('playwright', async (importOriginal) => {
  const actual = await importOriginal<typeof import('playwright')>()
  return {
    ...actual,
    chromium: {
      launch: async (options?: LaunchOptions): Promise<Browser> => {
        const browser = await actual.chromium.launch(options)
        shellState.launchedBrowsers.push(browser)
        // newContext だけをラップして route を差し込む（Browser の他の API はそのまま使う）。
        return new Proxy(browser, {
          get(target, property, receiver) {
            if (property === 'newContext') {
              return async (contextOptions?: BrowserContextOptions) => {
                if (shellState.failNewContext) {
                  throw new Error('合成の newContext 失敗')
                }
                const context = await target.newContext(contextOptions)
                if (shellState.routeHandler !== null) {
                  await context.route('**/*', shellState.routeHandler)
                }
                return context
              }
            }
            const value = Reflect.get(target, property, receiver) as unknown
            return typeof value === 'function'
              ? (value as (...args: readonly unknown[]) => unknown).bind(target)
              : value
          },
        })
      },
    },
  }
})

/** タイムアウトは注入して短縮する（実時間を待たない）。 */
const TEST_OPTIONS = {
  headless: true,
  timeouts: {
    navigationMs: 5000,
    targetWaitMs: 150,
    rowChangeMs: 400,
    pollIntervalMs: 40,
    snapshotIntervalMs: 60,
  },
} as const

/** 合成のセッション状態（実際の Cookie・セッショントークンは使わない）。 */
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

const launchedBrowser = (): Browser => {
  const browser = shellState.launchedBrowsers.at(-1)
  if (browser === undefined) {
    throw new Error('ブラウザが起動されていません')
  }
  return browser
}

beforeEach(() => {
  shellState.routeHandler = null
  shellState.failNewContext = false
  shellState.launchedBrowsers.length = 0
})

afterEach(async () => {
  // 失敗したテストでもブラウザを残さない（close 済みへの close は無害）。
  await Promise.all(
    shellState.launchedBrowsers.map((browser) => browser.close().catch(() => undefined)),
  )
})

describe('executeRefresh の外枠（モックした launch + 実 chromium）', () => {
  it('受付を確認したら OBSERVED を返し、ブラウザを閉じる', async () => {
    shellState.routeHandler = async (route) => {
      await route.fulfill({
        contentType: 'text/html',
        body: accountsHtml({
          bulk: 1,
          rows: [accountRow('口座A', '2026/10/01')],
          script: CHANGE_TIMESTAMP_SCRIPT,
        }),
      })
    }

    const outcome = await executeRefresh(syntheticSessionState, TEST_OPTIONS)

    expect(outcome.status).toBe('OBSERVED')
    if (outcome.status !== 'OBSERVED') {
      return
    }
    expect(outcome.observation.acceptance).toBe('ACCEPTED')
    expect(launchedBrowser().isConnected()).toBe(false)
  })

  it('未認証のページなら AUTH_REQUIRED を返し、ブラウザを閉じる', async () => {
    shellState.routeHandler = async (route) => {
      await route.fulfill({
        contentType: 'text/html',
        body: accountsHtml({ bulk: 1, body: '<input type="password">' }),
      })
    }

    const outcome = await executeRefresh(syntheticSessionState, TEST_OPTIONS)

    expect(outcome).toEqual({ status: 'AUTH_REQUIRED' })
    expect(launchedBrowser().isConnected()).toBe(false)
  })

  it('セッションを適用できない場合は SESSION_INVALID を返し、ブラウザを閉じる', async () => {
    shellState.failNewContext = true

    const outcome = await executeRefresh(syntheticSessionState, TEST_OPTIONS)

    expect(outcome).toEqual({ status: 'SESSION_INVALID' })
    expect(launchedBrowser().isConnected()).toBe(false)
  })

  it('遷移に失敗した場合は例外を投げ、ブラウザを閉じる（呼び出し側が Result へ写す）', async () => {
    shellState.routeHandler = async (route) => {
      await route.abort()
    }

    await expect(executeRefresh(syntheticSessionState, TEST_OPTIONS)).rejects.toThrow()
    expect(launchedBrowser().isConnected()).toBe(false)
  })
})

describe('checkSession の外枠（モックした launch + 実 chromium）', () => {
  it('認証済みなら VALID を返し、ブラウザを閉じる', async () => {
    shellState.routeHandler = async (route) => {
      await route.fulfill({
        contentType: 'text/html',
        body: accountsHtml({ rows: [accountRow('口座A', '2026/10/01')] }),
      })
    }

    expect(await checkSession(syntheticSessionState, TEST_OPTIONS)).toBe('VALID')
    expect(launchedBrowser().isConnected()).toBe(false)
  })

  it('セッションを適用できない場合は UNKNOWN を返し、ブラウザを閉じる', async () => {
    shellState.failNewContext = true

    expect(await checkSession(syntheticSessionState, TEST_OPTIONS)).toBe('UNKNOWN')
    expect(launchedBrowser().isConnected()).toBe(false)
  })
})

describe('inspectRefreshTargets の外枠（モックした launch + 実 chromium）', () => {
  it('対象が揃っていれば AVAILABLE を返し、ブラウザを閉じる', async () => {
    shellState.routeHandler = async (route) => {
      await route.fulfill({
        contentType: 'text/html',
        body: accountsHtml({ bulk: 1, rows: [accountRow('口座A', '2026/10/01')] }),
      })
    }

    expect(await inspectRefreshTargets(syntheticSessionState, TEST_OPTIONS)).toEqual({
      status: 'AVAILABLE',
    })
    expect(launchedBrowser().isConnected()).toBe(false)
  })

  it('一括更新コントロールが無ければ TARGET_NOT_FOUND を返し、ブラウザを閉じる', async () => {
    shellState.routeHandler = async (route) => {
      await route.fulfill({
        contentType: 'text/html',
        body: accountsHtml({ rows: [accountRow('口座A', '2026/10/01')] }),
      })
    }

    expect(await inspectRefreshTargets(syntheticSessionState, TEST_OPTIONS)).toEqual({
      status: 'TARGET_NOT_FOUND',
    })
    expect(launchedBrowser().isConnected()).toBe(false)
  })
})
