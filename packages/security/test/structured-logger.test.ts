import { describe, expect, it } from 'vitest'

import type { ErrorCode, LogEvent } from '@mf-suite/core'

import type { LogSink, StructuredLogRecord } from '../src/index.js'
import { createStructuredLogger } from '../src/index.js'

/**
 * 構造化ロガーの回帰テスト。敵対的入力（未知 key の混入・語彙外 errorCode のキャスト）でも
 * 許可 field 以外が出力へ現れないこと、出力 key が固定であることを検証する。
 * 値はすべて合成データ（実データ・Secret を使わない）。
 */

interface CapturingSink {
  readonly lines: string[]
  readonly sink: LogSink
}

/** 捕捉用 sink。出力された JSON 行を蓄え、テスト中は stdout へ出さない。 */
const createCapturingSink = (): CapturingSink => {
  const lines: string[] = []
  return {
    lines,
    sink: (jsonLine) => {
      lines.push(jsonLine)
    },
  }
}

/** 出力が 1 行であることを確認して JSON として解釈する。 */
const parseSingleLine = (lines: readonly string[]): Record<string, unknown> => {
  expect(lines).toHaveLength(1)
  const line = lines[0] as string
  expect(line).not.toContain('\n')
  return JSON.parse(line) as Record<string, unknown>
}

/** 合成データのみの基準イベント。 */
const baseEvent = {
  application: 'automation',
  job: 'refresh-accounts',
  status: 'STARTED',
  attempt: 1,
  durationMs: 12,
} as const satisfies LogEvent

/** timestamp + 6 field（失敗イベント）の出力 key。 */
const fullRecordKeys = [
  'timestamp',
  'application',
  'job',
  'status',
  'attempt',
  'durationMs',
  'errorCode',
] as const

/** 許可 field の名前一覧（timestamp を除く）。 */
const allowedFieldKeys = [
  'application',
  'job',
  'status',
  'attempt',
  'durationMs',
  'errorCode',
] as const

describe('構造化ロガーの出力（allow list）', () => {
  it('成功イベントは timestamp と 5 field の 6 key だけを出力する', () => {
    const capturing = createCapturingSink()
    const logger = createStructuredLogger({ application: 'automation', sink: capturing.sink })

    logger.log(baseEvent)

    const record = parseSingleLine(capturing.lines)
    expect(Object.keys(record)).toEqual([
      'timestamp',
      'application',
      'job',
      'status',
      'attempt',
      'durationMs',
    ])
    expect(record).not.toHaveProperty('errorCode')
    expect(record.application).toBe('automation')
    expect(record.job).toBe('refresh-accounts')
    expect(record.status).toBe('STARTED')
    expect(record.attempt).toBe(1)
    expect(record.durationMs).toBe(12)
    expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('失敗イベントは timestamp + 6 field の 7 key ちょうどで固定される', () => {
    const capturing = createCapturingSink()
    const logger = createStructuredLogger({ application: 'automation', sink: capturing.sink })

    const event: LogEvent = { ...baseEvent, status: 'FAILURE', errorCode: 'AUTH_REQUIRED' }
    logger.log(event)

    const record = parseSingleLine(capturing.lines)
    expect(Object.keys(record)).toEqual([...fullRecordKeys])
    expect(record.errorCode).toBe('AUTH_REQUIRED')
  })
})

describe('敵対的入力への防御（実行時の allow list）', () => {
  it('変数経由で混ぜた未知の key は出力へ現れない', () => {
    const capturing = createCapturingSink()
    const logger = createStructuredLogger({ application: 'automation', sink: capturing.sink })

    // 型では弾かれるが、キャストで実行時に混入する経路を再現する。
    const smuggledFields = {
      password: 'dummy-password-for-test',
      cookie: 'dummy-cookie-for-test',
      storageState: 'dummy-state-for-test',
      message: 'dummy-message-for-test',
    }
    const event = { ...baseEvent, ...smuggledFields } as LogEvent

    logger.log(event)

    const record = parseSingleLine(capturing.lines)
    expect(Object.keys(record)).toEqual([
      'timestamp',
      'application',
      'job',
      'status',
      'attempt',
      'durationMs',
    ])
    for (const key of Object.keys(smuggledFields)) {
      expect(record).not.toHaveProperty(key)
    }
    expect(capturing.lines[0]).not.toContain('dummy-password-for-test')
    expect(capturing.lines[0]).not.toContain('dummy-state-for-test')
  })

  it('as で余剰プロパティを付けたイベントでも未知の key は出力へ現れない', () => {
    const capturing = createCapturingSink()
    const logger = createStructuredLogger({ application: 'automation', sink: capturing.sink })

    const event = { ...baseEvent, sessionToken: 'dummy-token-for-test' } as LogEvent

    logger.log(event)

    const record = parseSingleLine(capturing.lines)
    expect(record).not.toHaveProperty('sessionToken')
    expect(Object.keys(record).every((key) => key === 'timestamp' || !key.includes('token'))).toBe(
      true,
    )
  })

  it('errorCode の語彙外の値は UNKNOWN へ丸め、生の値を出力しない', () => {
    const capturing = createCapturingSink()
    const logger = createStructuredLogger({ application: 'automation', sink: capturing.sink })

    const forgedErrorCode = 'LEAKED_FREE_STRING' as unknown as ErrorCode
    const event: LogEvent = { ...baseEvent, status: 'FAILURE', errorCode: forgedErrorCode }

    logger.log(event)

    const record = parseSingleLine(capturing.lines)
    expect(record.errorCode).toBe('UNKNOWN')
    expect(capturing.lines[0]).not.toContain('LEAKED_FREE_STRING')
  })

  it('束ねた application と異なるイベントは出力しない（Fail Closed）', () => {
    const capturing = createCapturingSink()
    const logger = createStructuredLogger({ application: 'automation', sink: capturing.sink })

    const event = { ...baseEvent, application: 'another-application' } as unknown as LogEvent

    logger.log(event)

    expect(capturing.lines).toEqual([])
  })

  it('出力はすべて JSON として解釈でき、key は許可 field の部分集合になる', () => {
    const capturing = createCapturingSink()
    const logger = createStructuredLogger({ application: 'automation', sink: capturing.sink })

    logger.log(baseEvent)
    logger.log({ ...baseEvent, status: 'SUCCESS', attempt: 2, durationMs: 34 })
    logger.log({ ...baseEvent, status: 'FAILURE', errorCode: 'TEMPORARY_FAILURE' })

    expect(capturing.lines).toHaveLength(3)
    for (const line of capturing.lines) {
      expect(line).not.toContain('\n')
      const parsed = JSON.parse(line) as Record<string, unknown>
      for (const key of Object.keys(parsed)) {
        if (key === 'timestamp') continue
        expect(allowedFieldKeys).toContain(key)
      }
      expect(parsed.application).toBe('automation')
      expect(parsed.job).toBe('refresh-accounts')
    }
  })
})

describe('値の実行時検証（fail closed）', () => {
  /** 値を検証できない（語彙外・型違い・欠落）イベントの表。 */
  const invalidEvents: Array<[string, unknown]> = [
    ['job が語彙外の自由文字列（キャスト混入）', { ...baseEvent, job: 'LEAKED_FREE_STRING' }],
    ['job が数値', { ...baseEvent, job: 1 }],
    ['status が語彙外の自由文字列（キャスト混入）', { ...baseEvent, status: 'LEAKED_FREE_STRING' }],
    [
      'status が欠落',
      { application: 'automation', job: 'refresh-accounts', attempt: 1, durationMs: 1 },
    ],
    [
      'attempt が toJSON を持つオブジェクト',
      { ...baseEvent, attempt: { toJSON: () => 'LEAKED_FREE_STRING' } },
    ],
    ['attempt が 0', { ...baseEvent, attempt: 0 }],
    ['attempt が小数', { ...baseEvent, attempt: 1.5 }],
    ['attempt が文字列', { ...baseEvent, attempt: '1' }],
    ['durationMs が NaN', { ...baseEvent, durationMs: Number.NaN }],
    ['durationMs が Infinity', { ...baseEvent, durationMs: Number.POSITIVE_INFINITY }],
    ['durationMs が負数', { ...baseEvent, durationMs: -1 }],
    ['durationMs が文字列', { ...baseEvent, durationMs: '12' }],
  ]

  it.each(invalidEvents)('%s のイベントは出力しない', (_label, event) => {
    const capturing = createCapturingSink()
    const logger = createStructuredLogger({ application: 'automation', sink: capturing.sink })

    logger.log(event as LogEvent)

    expect(capturing.lines).toEqual([])
  })

  it('null・undefined・非オブジェクトを渡しても出力しない', () => {
    const capturing = createCapturingSink()
    const logger = createStructuredLogger({ application: 'automation', sink: capturing.sink })
    const logUnknown = logger.log as unknown as (event: unknown) => void

    logUnknown(null)
    logUnknown(undefined)
    logUnknown('LEAKED_FREE_STRING')
    logUnknown(['automation'])

    expect(capturing.lines).toEqual([])
  })

  it('値の検証を通ったイベントは従来どおり出力される（過剰な遮断がないこと）', () => {
    const capturing = createCapturingSink()
    const logger = createStructuredLogger({ application: 'automation', sink: capturing.sink })

    logger.log({ ...baseEvent, status: 'PARTIAL_SUCCESS', attempt: 3, durationMs: 0 })

    const record = parseSingleLine(capturing.lines)
    expect(record.status).toBe('PARTIAL_SUCCESS')
    expect(record.attempt).toBe(3)
    expect(record.durationMs).toBe(0)
  })

  /** 同じ field へのアクセスごとに違う値を返す getter 付きイベントを作る（TOCTOU の再現）。 */
  const createGetterEvent = (
    field: 'job' | 'attempt',
    values: readonly [unknown, unknown],
  ): LogEvent => {
    let accessCount = 0
    const event: Record<string, unknown> = { ...baseEvent }
    Object.defineProperty(event, field, {
      enumerable: true,
      get: () => {
        const value = values[Math.min(accessCount, values.length - 1)]
        accessCount += 1
        return value
      },
    })
    return event as unknown as LogEvent
  }

  // 値は一度だけ読み、検証と出力に同じ値を使う。1 回目の読み出しで有効値・2 回目で任意値を
  // 返す getter でも、出力に現れるのは検証済みの 1 回目の値だけになる（1 回の読み出しでは
  // getter の 2 回目の戻り値は知り得ないため、この形は「無出力」ではなく「2 回目の値を
  // 出力しない」ことを固定する）。

  it('job の getter が 1 回目に語彙内・2 回目に任意値を返しても、出力は 1 回目の値だけ', () => {
    const capturing = createCapturingSink()
    const logger = createStructuredLogger({ application: 'automation', sink: capturing.sink })

    logger.log(createGetterEvent('job', ['refresh-accounts', 'LEAKED_FREE_STRING']))

    const record = parseSingleLine(capturing.lines)
    expect(record.job).toBe('refresh-accounts')
    expect(capturing.lines[0]).not.toContain('LEAKED_FREE_STRING')
  })

  it('attempt の getter が 1 回目に整数・2 回目に toJSON 持ちオブジェクトを返しても、出力は 1 回目の値だけ', () => {
    const capturing = createCapturingSink()
    const logger = createStructuredLogger({ application: 'automation', sink: capturing.sink })

    logger.log(createGetterEvent('attempt', [1, { toJSON: () => 'LEAKED_FREE_STRING' }]))

    const record = parseSingleLine(capturing.lines)
    expect(record.attempt).toBe(1)
    expect(capturing.lines[0]).not.toContain('LEAKED_FREE_STRING')
  })

  it('getter が 1 回目に語彙外の値を返すイベントは出力しない（Fail Closed）', () => {
    const capturing = createCapturingSink()
    const logger = createStructuredLogger({ application: 'automation', sink: capturing.sink })

    logger.log(createGetterEvent('job', ['LEAKED_FREE_STRING', 'refresh-accounts']))
    logger.log(createGetterEvent('attempt', [{ toJSON: () => 1 }, 1]))

    expect(capturing.lines).toEqual([])
  })
})

describe('既定 sink（stdout）', () => {
  it('sink を省略すると 1 イベントを改行付き 1 行の JSON で stdout へ書く', () => {
    const originalWrite = process.stdout.write
    const written: string[] = []
    const captureWrite = (chunk: string | Uint8Array): boolean => {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    }
    process.stdout.write = captureWrite as unknown as typeof process.stdout.write

    try {
      const logger = createStructuredLogger({ application: 'automation' })
      logger.log(baseEvent)
    } finally {
      process.stdout.write = originalWrite
    }

    expect(written).toHaveLength(1)
    const [line] = written
    expect(line).toBeTypeOf('string')
    expect((line as string).endsWith('\n')).toBe(true)
    const record = JSON.parse((line as string).trimEnd()) as unknown as StructuredLogRecord
    expect(Object.keys(record)).toEqual([
      'timestamp',
      'application',
      'job',
      'status',
      'attempt',
      'durationMs',
    ])
    expect(record.application).toBe('automation')
  })
})
