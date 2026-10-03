import { runRefreshAccounts } from './refresh-accounts-cli.js'
import { createRefreshAccountsCliDependencies } from './refresh-accounts-dependencies.js'

/**
 * 金融機関のデータ一括更新をローカルで実行する CLI（refresh-accounts）。
 * セッション（既定は .local/ 配下、MF_SESSION_FILE で上書き）を読み込み、本番と同じ
 * Handler / Use Case を 1 回だけ実行する。引数は --headed / --headless だけを受け付け、
 * URL・Selector・JavaScript・Shell Command・ID / Password は受け付けない（ADR-0010）。
 * stdout は status（失敗時は errorCode）の 1 行に限り、構造化ログは stderr へ出す
 * （stdout を契約の専有に保つ）。Secret・Cookie・金融情報は出力しない。
 * 終了コード: 0 = 成功、2 = 認証が必要、3 = 更新不要、4 = 部分成功、64 = 不正入力、1 = その他。
 * 依存の組み立ては refresh-accounts-dependencies.ts に分け、テストから配線（stderr の sink の
 * 指定）を検証できるようにする。
 */

const main = (): Promise<number> =>
  runRefreshAccounts(createRefreshAccountsCliDependencies(), process.argv.slice(2))

main()
  .then((exitCode) => {
    process.exitCode = exitCode
  })
  .catch(() => {
    // 例外の内容は出さない（URL・DOM・Cookie が混ざり得るため）。
    console.log('status=FAILURE errorCode=UNKNOWN')
    process.exitCode = 1
  })
