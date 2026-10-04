import { toApplicationResult } from '@mf-suite/core'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { toRefreshResult } from '../src/moneyforward/adapter.js'
import { resolveTimeouts } from '../src/moneyforward/locators.js'
import type { PreparedAccountsPage } from '../src/moneyforward/page-helpers.js'
import {
  checkAuthentication,
  collectAccountRows,
  prepareAccountsPage,
  readStableRowsSnapshot,
  resolveBulkUpdateControl,
} from '../src/moneyforward/page-helpers.js'
import { executeRefreshOnAccountsPage } from '../src/moneyforward/refresh-execution.js'
import {
  AUTH_LOST_DELAYED_SCRIPT,
  AUTH_LOST_SCRIPT,
  accountRow,
  accountsHtml,
  CHANGE_TIMESTAMP_SCRIPT,
  FAILURE_SCRIPT,
  FLUCTUATING_SCRIPT,
  ONE_FLUCTUATING_SCRIPT,
  PARTIAL_FAILURE_SCRIPT,
} from './synthetic-page.js'

/**
 * 実 chromium と合成 HTML（page.setContent）によるページ操作の統合テスト。
 * 本番の HTML / DOM・実サービス・実データは使わない（すべてテスト用に合成した文言・構造）。
 * タイムアウトは注入して短縮し、実時間を待たない。
 */

/** テスト用のタイムアウト（実時間を待たないよう短縮する）。 */
const TEST_TIMEOUTS = resolveTimeouts({
  navigationMs: 5000,
  targetWaitMs: 150,
  // クリックの actionability はブラウザ側の往復とフレームの安定確認を伴うため、出現待ち（150ms）
  // ではなくクリック専用の値を使う。負荷時に 150ms では正常な要素でもタイムアウトし得る
  // （クリックだけが一時障害へ倒れる）。実測で負荷時のクリックは最大 200ms 未満のため、
  // 十分な余裕を取りつつ、クリックが失敗するテスト（disabled の一括更新）も待ち時間を抑える。
  clickMs: 1000,
  rowChangeMs: 400,
  pollIntervalMs: 40,
  snapshotIntervalMs: 60,
})

let browser: Browser
const openedPages: Page[] = []

beforeAll(async () => {
  browser = await chromium.launch({ headless: true })
}, 60_000)

afterEach(async () => {
  await Promise.all(openedPages.splice(0).map((page) => page.close().catch(() => undefined)))
})

afterAll(async () => {
  await browser.close()
})

/** 合成 HTML を読み込んだページを開く（テスト終了時に閉じる）。 */
const openPage = async (html: string): Promise<Page> => {
  const page = await browser.newPage()
  openedPages.push(page)
  await page.setContent(html)
  return page
}

/** ページを開いて対象の特定まで進め、準備済みのページを返す。 */
const prepareForRefresh = async (
  html: string,
): Promise<{ readonly page: Page; readonly prepared: PreparedAccountsPage }> => {
  const page = await openPage(html)
  const preparation = await prepareAccountsPage(page, TEST_TIMEOUTS)
  if (preparation.status !== 'READY') {
    throw new Error(`ページの準備に失敗しました: ${preparation.reason}`)
  }
  return { page, prepared: preparation.prepared }
}

describe('resolveBulkUpdateControl（実 chromium・合成 HTML）', () => {
  it('一括更新コントロールが 1 件なら RESOLVED', async () => {
    const page = await openPage(accountsHtml({ bulk: 1 }))

    expect((await resolveBulkUpdateControl(page, TEST_TIMEOUTS)).status).toBe('RESOLVED')
  })

  it('0 件なら TARGET_NOT_FOUND（fail closed）', async () => {
    const page = await openPage(accountsHtml({ rows: [accountRow('口座A', '2026/10/01')] }))

    expect(await resolveBulkUpdateControl(page, TEST_TIMEOUTS)).toEqual({
      status: 'TARGET_NOT_FOUND',
    })
  })

  it('複数件なら TARGET_AMBIGUOUS（取り違えを避けて停止する）', async () => {
    const page = await openPage(accountsHtml({ bulk: 2 }))

    expect(await resolveBulkUpdateControl(page, TEST_TIMEOUTS)).toEqual({
      status: 'TARGET_AMBIGUOUS',
    })
  })
})

describe('collectAccountRows（実 chromium・合成 HTML）', () => {
  it('「更新」コントロールを含む行を列挙する', async () => {
    const page = await openPage(
      accountsHtml({
        bulk: 1,
        rows: [accountRow('口座A', '2026/10/01'), accountRow('口座B', '2026/10/01')],
      }),
    )

    const rows = await collectAccountRows(page, TEST_TIMEOUTS)

    expect(rows).not.toBeNull()
    expect(rows?.length).toBe(2)
  })

  it('該当する行が無ければ null（fail closed）', async () => {
    const page = await openPage(accountsHtml({ bulk: 1 }))

    expect(await collectAccountRows(page, TEST_TIMEOUTS)).toBeNull()
  })
})

describe('checkAuthentication（実 chromium・合成 HTML）', () => {
  it('本文のある通常ページは OK', async () => {
    const page = await openPage(accountsHtml({ rows: [accountRow('口座A', '2026/10/01')] }))

    expect(await checkAuthentication(page, TEST_TIMEOUTS)).toBe('OK')
  })

  it('sign_in URL への遷移は AUTH_REQUIRED', async () => {
    const page = await browser.newPage()
    openedPages.push(page)
    // 実サービスへ到達させない（route で合成ページを返す）。URL は sign_in のまま維持される。
    await page.route('**/*', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: accountsHtml({ rows: [accountRow('口座A', '2026/10/01')] }),
      }),
    )
    await page.goto('https://moneyforward.com/users/sign_in')

    expect(await checkAuthentication(page, TEST_TIMEOUTS)).toBe('AUTH_REQUIRED')
  })

  it('可視のパスワード入力欄があれば AUTH_REQUIRED', async () => {
    const page = await openPage(
      accountsHtml({ rows: [accountRow('口座A', '2026/10/01')], body: '<input type="password">' }),
    )

    expect(await checkAuthentication(page, TEST_TIMEOUTS)).toBe('AUTH_REQUIRED')
  })

  it('本文を取得できない（空の）ページは判定不能の TEMPORARY_FAILURE（fail closed）', async () => {
    const page = await openPage(accountsHtml({}))

    expect(await checkAuthentication(page, TEST_TIMEOUTS)).toBe('TEMPORARY_FAILURE')
  })
})

describe('prepareAccountsPage（実 chromium・合成 HTML）', () => {
  it('認証済みで対象が揃っていれば READY', async () => {
    const page = await openPage(
      accountsHtml({ bulk: 1, rows: [accountRow('口座A', '2026/10/01')] }),
    )

    const preparation = await prepareAccountsPage(page, TEST_TIMEOUTS)

    expect(preparation.status).toBe('READY')
  })

  it('未認証なら BLOCKED（AUTH_REQUIRED）', async () => {
    const page = await openPage(accountsHtml({ bulk: 1, body: '<input type="password">' }))

    expect(await prepareAccountsPage(page, TEST_TIMEOUTS)).toEqual({
      status: 'BLOCKED',
      reason: 'AUTH_REQUIRED',
    })
  })

  it('判定不能なら BLOCKED（TEMPORARY_FAILURE）', async () => {
    const page = await openPage(accountsHtml({}))

    expect(await prepareAccountsPage(page, TEST_TIMEOUTS)).toEqual({
      status: 'BLOCKED',
      reason: 'TEMPORARY_FAILURE',
    })
  })

  it('一括更新コントロールが無ければ BLOCKED（TARGET_NOT_FOUND）', async () => {
    const page = await openPage(accountsHtml({ rows: [accountRow('口座A', '2026/10/01')] }))

    expect(await prepareAccountsPage(page, TEST_TIMEOUTS)).toEqual({
      status: 'BLOCKED',
      reason: 'TARGET_NOT_FOUND',
    })
  })
})

describe('readStableRowsSnapshot（実 chromium・合成 HTML）', () => {
  it('全行が安定していれば比較の基準になる', async () => {
    const page = await openPage(
      accountsHtml({
        bulk: 1,
        rows: [accountRow('口座A', '2026/10/01'), accountRow('口座B', '2026/10/01')],
      }),
    )
    const rows = await collectAccountRows(page, TEST_TIMEOUTS)
    expect(rows).not.toBeNull()

    const snapshot = await readStableRowsSnapshot(page, rows ?? [], TEST_TIMEOUTS)

    expect(snapshot).not.toBeNull()
    expect(snapshot?.[0]).toContain('口座A')
    expect(snapshot?.[1]).toContain('口座B')
  })

  it('自然変動する行は null として比較の基準から除外する', async () => {
    const page = await openPage(
      accountsHtml({
        bulk: 1,
        rows: [accountRow('口座A', '2026/10/01'), accountRow('口座B', '2026/10/01')],
        script: ONE_FLUCTUATING_SCRIPT,
      }),
    )
    const rows = await collectAccountRows(page, TEST_TIMEOUTS)
    expect(rows).not.toBeNull()

    const snapshot = await readStableRowsSnapshot(page, rows ?? [], TEST_TIMEOUTS)

    expect(typeof snapshot?.[0]).toBe('string')
    expect(snapshot?.[1]).toBeNull()
  })
})

describe('executeRefreshOnAccountsPage（実 chromium・合成 HTML）', () => {
  it('行の更新日時が変化したら ACCEPTED として観測する', async () => {
    const { prepared } = await prepareForRefresh(
      accountsHtml({
        bulk: 1,
        rows: [accountRow('口座A', '2026/10/01'), accountRow('口座B', '2026/10/01')],
        script: CHANGE_TIMESTAMP_SCRIPT,
      }),
    )

    const outcome = await executeRefreshOnAccountsPage(prepared, TEST_TIMEOUTS)

    expect(outcome.status).toBe('OBSERVED')
    if (outcome.status !== 'OBSERVED') {
      return
    }
    expect(outcome.observation).toEqual({
      acceptance: 'ACCEPTED',
      observedRowCount: 2,
      changedRowCount: 2,
      failedRowCount: 0,
      inProgressAppeared: false,
      authLost: false,
    })
  })

  it('変化が無ければ NOT_ACCEPTED（クリック成功を成功としない）', async () => {
    const { prepared } = await prepareForRefresh(
      accountsHtml({
        bulk: 1,
        rows: [accountRow('口座A', '2026/10/01'), accountRow('口座B', '2026/10/01')],
      }),
    )

    const outcome = await executeRefreshOnAccountsPage(prepared, TEST_TIMEOUTS)

    expect(outcome.status).toBe('OBSERVED')
    if (outcome.status !== 'OBSERVED') {
      return
    }
    expect(outcome.observation).toEqual({
      acceptance: 'NOT_ACCEPTED',
      observedRowCount: 2,
      changedRowCount: 0,
      failedRowCount: 0,
      inProgressAppeared: false,
      authLost: false,
    })
  })

  it('失敗文言が出現したら拒否として扱う（fail closed）', async () => {
    const { prepared } = await prepareForRefresh(
      accountsHtml({
        bulk: 1,
        rows: [accountRow('口座A', '2026/10/01'), accountRow('口座B', '2026/10/01')],
        script: FAILURE_SCRIPT,
      }),
    )

    const outcome = await executeRefreshOnAccountsPage(prepared, TEST_TIMEOUTS)

    expect(outcome.status).toBe('OBSERVED')
    if (outcome.status !== 'OBSERVED') {
      return
    }
    expect(outcome.observation).toEqual({
      acceptance: 'NOT_ACCEPTED',
      observedRowCount: 2,
      changedRowCount: 0,
      failedRowCount: 1,
      inProgressAppeared: false,
      authLost: false,
    })
  })

  it('一部の行が変化し一部の行が失敗したら、部分成功として観測し PARTIAL_SUCCESS へ写像される', async () => {
    const { prepared } = await prepareForRefresh(
      accountsHtml({
        bulk: 1,
        rows: [accountRow('口座A', '2026/10/01'), accountRow('口座B', '2026/10/01')],
        script: PARTIAL_FAILURE_SCRIPT,
      }),
    )

    const outcome = await executeRefreshOnAccountsPage(prepared, TEST_TIMEOUTS)

    expect(outcome.status).toBe('OBSERVED')
    if (outcome.status !== 'OBSERVED') {
      return
    }
    expect(outcome.observation).toEqual({
      acceptance: 'ACCEPTED',
      observedRowCount: 2,
      changedRowCount: 1,
      failedRowCount: 1,
      inProgressAppeared: false,
      authLost: false,
    })

    // Adapter の写像と core の写像を続けて通し、部分成功に到達することを端から端で固定する。
    const result = toRefreshResult(outcome)
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(toApplicationResult(result.value)).toEqual({ status: 'PARTIAL_SUCCESS' })
  })

  it('クリックできない場合は TEMPORARY_FAILURE（状態変化を確認できないため受付としない）', async () => {
    // disabled の一括更新コントロールは可視のため特定はできるが、クリックはタイムアウトする。
    const { prepared } = await prepareForRefresh(
      accountsHtml({
        bulk: 1,
        disabledBulk: true,
        rows: [accountRow('口座A', '2026/10/01')],
      }),
    )

    const outcome = await executeRefreshOnAccountsPage(prepared, TEST_TIMEOUTS)

    expect(outcome).toEqual({ status: 'TEMPORARY_FAILURE' })
  })

  it('クリックの予算は出現待ちと独立している（clickMs だけがクリックを制限する）', async () => {
    const { page, prepared } = await prepareForRefresh(
      accountsHtml({
        bulk: 1,
        rows: [accountRow('口座A', '2026/10/01')],
        script: AUTH_LOST_SCRIPT,
      }),
    )

    // クリックにだけ極端に短い予算を与える。actionability の確認は連続するフレームをまたぐため
    // 1ms では完了せず、クリックはタイムアウトする。実装が出現待ち（150ms）をクリックにも
    // 使っていれば、クリックは成功して認証失効の観測（OBSERVED / authLost）になる。
    // この差で、クリックの予算が出現待ちと共用されていないことを固定する。
    const outcome = await executeRefreshOnAccountsPage(
      prepared,
      resolveTimeouts({ ...TEST_TIMEOUTS, clickMs: 1 }),
    )

    expect(outcome).toEqual({ status: 'TEMPORARY_FAILURE' })
    // クリックがページへ届いていないこと（合成スクリプトが記録する）も確認する。
    expect(await page.locator('body').getAttribute('data-clicked')).toBeNull()
  })

  it('クリック後に認証が失われたら authLost として観測する', async () => {
    const { prepared } = await prepareForRefresh(
      accountsHtml({
        bulk: 1,
        rows: [accountRow('口座A', '2026/10/01')],
        script: AUTH_LOST_SCRIPT,
      }),
    )

    const outcome = await executeRefreshOnAccountsPage(prepared, TEST_TIMEOUTS)

    expect(outcome.status).toBe('OBSERVED')
    if (outcome.status !== 'OBSERVED') {
      return
    }
    expect(outcome.observation).toEqual({
      acceptance: 'NOT_ACCEPTED',
      observedRowCount: 1,
      changedRowCount: 0,
      failedRowCount: 0,
      inProgressAppeared: false,
      authLost: true,
    })
  })

  it('観測中にセッションが失効したら authLost として早期に観測する（TEMPORARY_FAILURE へ倒さない）', async () => {
    const { prepared } = await prepareForRefresh(
      accountsHtml({
        bulk: 1,
        rows: [accountRow('口座A', '2026/10/01')],
        script: AUTH_LOST_DELAYED_SCRIPT,
      }),
    )

    // 失効の確認間隔（数ポーリング）を迎えるまで観測が続くよう、期限を少し延ばす（実時間は待たない）。
    const observingTimeouts = resolveTimeouts({
      ...TEST_TIMEOUTS,
      rowChangeMs: 1500,
    })

    const outcome = await executeRefreshOnAccountsPage(prepared, observingTimeouts)

    expect(outcome).toEqual({
      status: 'OBSERVED',
      observation: {
        acceptance: 'NOT_ACCEPTED',
        observedRowCount: 1,
        changedRowCount: 0,
        failedRowCount: 0,
        inProgressAppeared: false,
        authLost: true,
      },
    })
  })

  it('全行が自然変動する場合はクリックせずに TEMPORARY_FAILURE（fail closed）', async () => {
    const { page, prepared } = await prepareForRefresh(
      accountsHtml({
        bulk: 1,
        rows: [accountRow('口座A', '2026/10/01'), accountRow('口座B', '2026/10/01')],
        script: FLUCTUATING_SCRIPT,
      }),
    )

    const outcome = await executeRefreshOnAccountsPage(prepared, TEST_TIMEOUTS)

    expect(outcome).toEqual({ status: 'TEMPORARY_FAILURE' })
    expect(await page.locator('body').getAttribute('data-clicked')).toBeNull()
  })
})
