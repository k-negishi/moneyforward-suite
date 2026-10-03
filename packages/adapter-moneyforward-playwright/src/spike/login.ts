import { chromium } from 'playwright'
import type { Page } from 'playwright'

import {
  AUTH_CHALLENGE_INPUT_SELECTOR,
  LOGIN_URL,
  ME_HOME_URL,
  NAVIGATION_TIMEOUT_MS,
  TARGET_WAIT_TIMEOUT_MS,
  formatSessionPathForDisplay,
  isSignInUrl,
  resolveSessionFilePath,
} from './config.js'
import { waitForEnter } from './prompt.js'
import { saveSessionState } from './session.js'
import { authStateToLoginStatus, classifyAuthState } from './state.js'
import type { AuthStateSignals } from './state.js'

/**
 * 手動ログイン用の spike CLI。
 * Password を扱わず、ユーザーがブラウザでログインした結果のセッションだけを保存する（ADR-0012）。
 * CAPTCHA / OTP / 新端末確認は自動回避しない（ADR-0015）。
 * 終了コード: 0 = 保存成功、2 = ログイン未完了（AUTH_REQUIRED）、1 = その他エラー（TEMPORARY_FAILURE 等）。
 */

/** 認証状態の観測値をページから集める（分類は state.ts の純関数が行う）。 */
const collectAuthStateSignals = async (page: Page): Promise<AuthStateSignals> => ({
  isSignInUrl: isSignInUrl(page.url()),
  visibleText: await page
    .locator('body')
    .innerText({ timeout: TARGET_WAIT_TIMEOUT_MS })
    .catch(() => ''),
  visibleChallengeInputCount: await page
    .locator(AUTH_CHALLENGE_INPUT_SELECTOR)
    .filter({ visible: true })
    .count(),
})

/**
 * headed ブラウザでログイン画面を開き、手動ログイン後のセッションを保存する。
 * 終了コード: 0 = 保存成功、2 = ログイン未完了（AUTH_REQUIRED）、1 = その他エラー。
 */
const main = async (): Promise<number> => {
  const sessionFilePath = resolveSessionFilePath()

  const browser = await chromium.launch({ headless: false })
  try {
    const context = await browser.newContext()
    const page = await context.newPage()
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS)

    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' })

    console.log('ブラウザで MoneyForward ME に手動ログインしてください。')
    console.log('CAPTCHA・ワンタイムパスワード・新端末確認はご自身で対応してください（自動回避しません）。')
    const completed = await waitForEnter('ログインが完了したら Enter を押してください: ')
    if (!completed) {
      // stdin が閉じた（非対話・EOF）。待機でハングせず、未完了として終了する。
      console.log('status=AUTH_REQUIRED')
      console.log('ログイン完了を確認できなかったため、セッションは保存していません。')
      return 2
    }

    // ログイン状態を三値で判定し、CLI の結果へ写す。未認証は AUTH_REQUIRED、
    // 判定不能（本文取得失敗）は TEMPORARY_FAILURE として、いずれも保存しない（fail closed）。
    await page.goto(ME_HOME_URL, { waitUntil: 'domcontentloaded' })
    const authState = classifyAuthState(await collectAuthStateSignals(page))
    const loginStatus = authStateToLoginStatus(authState)
    if (loginStatus !== 'SESSION_SAVED') {
      console.log(`status=${loginStatus}`)
      console.log(
        loginStatus === 'AUTH_REQUIRED'
          ? 'ログインを確認できなかったため、セッションは保存していません。'
          : 'ログイン状態を確認できなかったため（本文を取得できない）、セッションは保存していません。',
      )
      return loginStatus === 'AUTH_REQUIRED' ? 2 : 1
    }

    saveSessionState(sessionFilePath, await context.storageState())
    console.log(`status=${loginStatus}`)
    console.log(`session ファイル: ${formatSessionPathForDisplay(sessionFilePath)}`)
    return 0
  } finally {
    // 成功・失敗のどちらでもブラウザを閉じる。
    await browser.close()
  }
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode
  })
  .catch(() => {
    // 例外の内容は出さない（URL や入力断片が混ざり得るため）。
    console.log('status=TEMPORARY_FAILURE')
    process.exitCode = 1
  })
