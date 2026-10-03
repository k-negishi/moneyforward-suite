import { resolveSessionFilePath } from '@mf-suite/security'

import { runManualLoginSession } from '../moneyforward/page-client.js'
import { waitForEnter } from './prompt.js'
import { runSessionLogin } from './session-cli.js'

/**
 * 手動ログインでセッションを生成する CLI（session:login）。
 * headed ブラウザでログイン画面を開き、ユーザーが Enter を押した後に認証状態を確認する。
 * 認証済みと確認できた場合だけ storageState をセッションとして保存する（Password は扱わない）。
 * 認証チャレンジを検知した場合は保存せず AUTH_REQUIRED で停止する（自動回避しない）。
 * 終了コード: 0 = 保存成功、2 = 認証が必要（未完了・未認証）、1 = その他。
 * 保存先は MF_SESSION_FILE（絶対パス）で上書きでき、既定は .local/ 配下（git 管理外）。
 */

const main = (): Promise<number> =>
  runSessionLogin({
    resolveSessionFilePath,
    runManualLogin: runManualLoginSession,
    waitForEnter,
    writeStdout: (line) => {
      console.log(line)
    },
    writeStderr: (line) => {
      console.error(line)
    },
  })

main()
  .then((exitCode) => {
    process.exitCode = exitCode
  })
  .catch(() => {
    // 例外の内容は出さない（URL・DOM・Cookie が混ざり得るため）。
    console.log('status=TEMPORARY_FAILURE')
    process.exitCode = 1
  })
