import { readSessionFile, resolveSessionFilePath } from '@mf-suite/security'
import type { RefreshOptions, SpikeStatus } from '../cli/refresh-cli.js'
import {
  EXIT_CODE_BY_STATUS,
  parseRefreshArgs,
  REFRESH_USAGE,
  toSpikeStatus,
} from '../cli/refresh-cli.js'
import { executeRefresh, inspectRefreshTargets } from '../moneyforward/page-client.js'

/**
 * 金融機関のデータ一括更新を実行し、行ごとの変化（受付）を確認する暫定 CLI。
 * 手動更新と同じ導線（口座一覧ページの一括更新コントロール）を使う。ページ操作の本体は
 * moneyforward の各モジュールへ移設済みで、このエントリはセッション読込・引数解析・
 * 出力（status=... のみ）・終了コードだけを担う。
 * ・URL / Selector / 操作を引数で受け付けない（ADR-0010）
 * ・出力は status=... のみ（金額・カード番号・Cookie・セッション・URL は出さない）
 * ・Screenshot / HTML dump / HAR / Trace / Video を保存しない（ADR-0017）
 */

/** セッションを読み込み、モードに応じて更新可否の確認または一括更新の実行を行う。 */
const run = async (options: RefreshOptions): Promise<SpikeStatus> => {
  const session = readSessionFile(resolveSessionFilePath())
  if (session.status !== 'OK') {
    return session.status
  }

  const outcome = options.execute
    ? await executeRefresh(session.sessionState, { headless: options.headless })
    : await inspectRefreshTargets(session.sessionState, { headless: options.headless })

  return toSpikeStatus(outcome)
}

const main = async (): Promise<number> => {
  const options = parseRefreshArgs(process.argv.slice(2))
  if (options === null) {
    console.error(REFRESH_USAGE)
    return 1
  }

  try {
    const status = await run(options)
    console.log(`status=${status}`)
    return EXIT_CODE_BY_STATUS[status]
  } catch {
    // 例外の内容は出さない（URL・DOM・Cookie が混ざり得るため）。
    console.log('status=TEMPORARY_FAILURE')
    return 1
  }
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode
  })
  .catch(() => {
    console.log('status=TEMPORARY_FAILURE')
    process.exitCode = 1
  })
