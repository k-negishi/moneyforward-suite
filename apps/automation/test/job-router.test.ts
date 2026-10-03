import { describe, expect, it } from 'vitest'
import { routeJob } from '../src/job-router.js'

/**
 * Job Router の検証。受理するのは `{ job: 'refresh-accounts', attempt?: 1..3 }` の形だけで、
 * それ以外（未知の Job・欠落・形式不正・余剰フィールド）はすべて INVALID_JOB で拒否されることを
 * 固定する。入力から任意の操作（URL・Selector・JavaScript・コマンド）を指定できないことが要件。
 */

/** 拒否を期待し、分類だけを検査する（受理された場合はテストを落とす）。 */
const expectRejected = (input: unknown): void => {
  const result = routeJob(input)
  if (result.ok) {
    throw new Error('拒否を期待したが受理された')
  }
  expect(result.error.code).toBe('INVALID_JOB')
}

/** 受理を期待し、実行内容を取り出す（拒否された場合はテストを落とす）。 */
const expectAccepted = (input: unknown): { readonly job: string; readonly attempt: number } => {
  const result = routeJob(input)
  if (!result.ok) {
    throw new Error(`受理を期待したが拒否された: ${result.error.code}`)
  }
  return result.value
}

describe('Job Router', () => {
  it('refresh-accounts を受理し、attempt 省略時は初回（1）にする', () => {
    expect(expectAccepted({ job: 'refresh-accounts' })).toEqual({
      job: 'refresh-accounts',
      attempt: 1,
    })
  })

  it.each([1, 2, 3])('attempt=%i を受理する', (attempt) => {
    expect(expectAccepted({ job: 'refresh-accounts', attempt })).toEqual({
      job: 'refresh-accounts',
      attempt,
    })
  })

  it('attempt の明示的な undefined は省略と同じ扱いにする', () => {
    expect(expectAccepted({ job: 'refresh-accounts', attempt: undefined })).toEqual({
      job: 'refresh-accounts',
      attempt: 1,
    })
  })

  it('余剰フィールドを持つ入力は、許可 Job でも拒否する', () => {
    expectRejected({ job: 'refresh-accounts', url: 'https://example.invalid/' })
    expectRejected({ job: 'refresh-accounts', selector: '#target' })
    expectRejected({ job: 'refresh-accounts', action: 'click' })
    expectRejected({ job: 'refresh-accounts', script: 'return document.cookie' })
    expectRejected({ job: 'refresh-accounts', command: 'echo synthetic' })
    expectRejected({ job: 'refresh-accounts', attempt: 1, headless: false })
  })

  const rejectedCases: ReadonlyArray<readonly [string, unknown]> = [
    ['未知の Job', { job: 'refresh-suica' }],
    ['空文字の Job', { job: '' }],
    ['job が欠落した入力', { attempt: 1 }],
    ['空のオブジェクト', {}],
    ['大文字違いの Job', { job: 'Refresh-Accounts' }],
    ['job が数値', { job: 1 }],
    ['job が配列', { job: ['refresh-accounts'] }],
    ['job が null', { job: null }],
    ['入力が null', null],
    ['入力が undefined', undefined],
    ['入力が文字列', 'refresh-accounts'],
    ['入力が数値', 1],
    ['入力が真偽値', true],
    ['入力が配列', ['refresh-accounts']],
    ['attempt が文字列', { job: 'refresh-accounts', attempt: '1' }],
    ['attempt が 0', { job: 'refresh-accounts', attempt: 0 }],
    ['attempt が 4', { job: 'refresh-accounts', attempt: 4 }],
    ['attempt が負数', { job: 'refresh-accounts', attempt: -1 }],
    ['attempt が小数', { job: 'refresh-accounts', attempt: 1.5 }],
    ['attempt が NaN', { job: 'refresh-accounts', attempt: Number.NaN }],
    ['attempt が Infinity', { job: 'refresh-accounts', attempt: Number.POSITIVE_INFINITY }],
    ['attempt が真偽値', { job: 'refresh-accounts', attempt: true }],
    ['attempt が null', { job: 'refresh-accounts', attempt: null }],
    ['attempt がオブジェクト', { job: 'refresh-accounts', attempt: { value: 1 } }],
  ]

  it.each(rejectedCases)('%s を拒否する', (_name, input) => {
    expectRejected(input)
  })
})
