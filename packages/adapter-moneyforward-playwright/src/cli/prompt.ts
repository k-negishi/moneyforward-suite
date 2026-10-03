import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'

/**
 * Enter の入力（または stdin の EOF / クローズ）まで待つ。
 * readline の question() は stdin が閉じても解決・棄却されないため、close イベントで
 * 未完了として解決する（非対話の stdin でプロセスがハングしないようにする）。
 * 戻り値は入力行を確認できたら true、EOF / クローズで false。
 */
export const waitForEnter = (message: string): Promise<boolean> =>
  new Promise((resolve) => {
    const readline = createInterface({ input: stdin, output: stdout })
    let settled = false

    const finish = (completed: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      readline.close()
      resolve(completed)
    }

    readline.on('close', () => finish(false))
    readline.question(message).then(
      () => finish(true),
      () => finish(false),
    )
  })
