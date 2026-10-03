import { createLocalAutomation } from '../composition-root.js'
import { writeStructuredLogToStderr } from './log-sink.js'
import type { RefreshAccountsCliDependencies } from './refresh-accounts-cli.js'

/**
 * refresh-accounts CLI の本番配線（依存の組み立て）。エントリポイントはこの関数を使い、
 * テストも同じ関数を通して「構造化ログの出力先が stderr であること」を検証する
 * （配線が外れたらテストが落ちる）。Composition Root の呼び出しは createHandler の中だけで、
 * この関数とテストは実ブラウザ・実サービスへ接続しない。
 * 出力は console ではなく process の stream へ 1 行ずつ直接書く（stdout を status 行の
 * 専有に保ち、テストから実測で固定できるようにする）。
 */
export const createRefreshAccountsCliDependencies = (): RefreshAccountsCliDependencies => ({
  // 一括更新の実行は Composition Root（local 構成）の Handler / Use Case に任せ、
  // ページ操作の詳細と業務判断を CLI へ重複実装しない。セッションのパス解決と読み込みも
  // Composition Root の Session Provider（security の既定解決）に任せる。
  // 構造化ログは stderr の sink を注入し、stdout を status 行だけに固定する。
  createHandler: (options) =>
    createLocalAutomation({ headless: options.headless, logSink: writeStructuredLogToStderr }),
  writeStdout: (line) => {
    process.stdout.write(`${line}\n`)
  },
  writeStderr: (line) => {
    process.stderr.write(`${line}\n`)
  },
})
