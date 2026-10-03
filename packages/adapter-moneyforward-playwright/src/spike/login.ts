import { formatSessionPathForDisplay, resolveSessionFilePath } from '@mf-suite/security'

import { waitForEnter } from '../cli/prompt.js'
import { runManualLoginSession } from '../moneyforward/page-client.js'

/**
 * 手動ログイン用の暫定 CLI。
 * Password を扱わず、ユーザーがブラウザでログインした結果のセッションだけを保存する（ADR-0012）。
 * CAPTCHA / OTP / 新端末確認は自動回避しない（ADR-0015）。
 * 終了コード: 0 = 保存成功、2 = ログイン未完了（AUTH_REQUIRED）、1 = その他エラー（TEMPORARY_FAILURE 等）。
 */

const main = async (): Promise<number> => {
  const sessionFilePath = resolveSessionFilePath()

  // 案内の表示と Enter の待機は CLI 側の責務とし、ログイン画面を開いた後に呼ばれる。
  // 待機する処理はないため async は付けず、Promise を直接返す（useAwait に合わせる）。
  const result = await runManualLoginSession(sessionFilePath, () => {
    console.log('ブラウザで MoneyForward ME に手動ログインしてください。')
    console.log(
      'CAPTCHA・ワンタイムパスワード・新端末確認はご自身で対応してください（自動回避しません）。',
    )
    return waitForEnter('ログインが完了したら Enter を押してください: ')
  })

  switch (result.status) {
    case 'SESSION_SAVED':
      console.log('status=SESSION_SAVED')
      console.log(`session ファイル: ${formatSessionPathForDisplay(sessionFilePath)}`)
      return 0
    case 'NOT_COMPLETED':
      // stdin が閉じた（非対話・EOF）。待機でハングせず、未完了として終了する。
      console.log('status=AUTH_REQUIRED')
      console.log('ログイン完了を確認できなかったため、セッションは保存していません。')
      return 2
    case 'AUTH_REQUIRED':
      console.log('status=AUTH_REQUIRED')
      console.log('ログインを確認できなかったため、セッションは保存していません。')
      return 2
    case 'TEMPORARY_FAILURE':
      console.log('status=TEMPORARY_FAILURE')
      console.log(
        'ログイン状態を確認できなかったため（本文を取得できない）、セッションは保存していません。',
      )
      return 1
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
