import { readSessionFile, resolveSessionFilePath } from '@mf-suite/security'

import { PlaywrightMoneyForwardAdapter } from '../moneyforward/adapter.js'
import { runSessionCheck } from './session-cli.js'

/**
 * 保存済みセッションの有効性を確認する CLI（session:check）。
 * headless ブラウザで口座一覧ページを開き、認証状態から有効性を判定する。
 * セッションの欠如・破損ではブラウザを起動せず、その場で区別して停止する。
 * 終了コード: 0 = 有効、2 = 失効（AUTH_REQUIRED）、1 = 欠如・破損・判定不能。
 */

const adapter = new PlaywrightMoneyForwardAdapter({ headless: true })

const main = (): Promise<number> =>
  runSessionCheck({
    resolveSessionFilePath,
    readSessionFile,
    verifySession: (session) => adapter.verifySession(session),
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
