import { PassThrough, Writable } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { waitForEnter } from '../src/cli/prompt.js'

/** readline がプロンプトを書き込む先（テストでは内容を捨てる）。 */
const createDiscardOutput = (): Writable =>
  new Writable({
    write: (_chunk, _encoding, callback) => {
      callback()
    },
  })

// Enter 待機は非対話の stdin（EOF）でもハングせず false を返すことを固定する。
// 入出力は合成ストリームを注入し、プロセスの stdin / stdout には依存しない。
describe('waitForEnter', () => {
  it('入力行を確認できたら true を返す', async () => {
    const input = new PassThrough()
    const resultPromise = waitForEnter('テスト: ', {
      input,
      output: createDiscardOutput(),
    })

    input.write('\n')
    input.end()

    expect(await resultPromise).toBe(true)
  })

  it('EOF（入力なし）では false を返す（ハングしない）', async () => {
    const input = new PassThrough()
    const resultPromise = waitForEnter('テスト: ', {
      input,
      output: createDiscardOutput(),
    })

    input.end()

    expect(await resultPromise).toBe(false)
  })
})
