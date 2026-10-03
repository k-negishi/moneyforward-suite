import { afterEach, describe, expect, it, vi } from 'vitest'

import { writeStructuredLogToStderr } from '../src/cli/log-sink.js'
import { createRefreshAccountsCliDependencies } from '../src/cli/refresh-accounts-dependencies.js'
import { createLocalAutomation } from '../src/composition-root.js'

/**
 * refresh-accounts CLI の本番配線（依存の組み立て）の検証。Composition Root をモックし、
 * エントリポイントが使う組み立てが「構造化ログを stderr の sink へ出し、stdout を status 行の
 * 専有に保つ」形であることを固定する。配線が外れたら（logSink の指定が消えたら）ここが落ちる。
 * 実ブラウザ・実サービスへは接続しない。
 */

vi.mock('../src/composition-root.js', () => ({
  createLocalAutomation: vi.fn(() => async () => ({ status: 'SUCCESS' })),
}))

/** process への実書き込みを capture する（配線先の実測）。 */
const captureProcessOutput = (): {
  readonly stdout: string[]
  readonly stderr: string[]
  readonly restore: () => void
} => {
  const stdout: string[] = []
  const stderr: string[] = []
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk))
    return true
  })
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk))
    return true
  })
  return {
    stdout,
    stderr,
    restore: () => {
      stdoutSpy.mockRestore()
      stderrSpy.mockRestore()
    },
  }
}

describe('本番配線（依存の組み立て）', () => {
  afterEach(() => {
    vi.mocked(createLocalAutomation).mockClear()
  })

  it('createHandler は local 構成へ headless と stderr の logSink を渡す', () => {
    createRefreshAccountsCliDependencies().createHandler({ headless: true })

    expect(createLocalAutomation).toHaveBeenCalledWith({
      headless: true,
      logSink: writeStructuredLogToStderr,
    })
  })

  it('createHandler は呼び出しごとの headless を渡し直す（配線を固定しない）', () => {
    createRefreshAccountsCliDependencies().createHandler({ headless: false })

    expect(createLocalAutomation).toHaveBeenCalledWith({
      headless: false,
      logSink: writeStructuredLogToStderr,
    })
  })

  it('writeStdout / writeStderr は標準出力・標準エラーへ 1 行ずつ書く', () => {
    const captured = captureProcessOutput()
    try {
      const dependencies = createRefreshAccountsCliDependencies()
      dependencies.writeStdout('status=SUCCESS')
      dependencies.writeStderr('使い方')

      expect(captured.stdout).toEqual(['status=SUCCESS\n'])
      expect(captured.stderr).toEqual(['使い方\n'])
    } finally {
      captured.restore()
    }
  })

  it('stderr の sink は stderr だけへ 1 行として書く（stdout へ漏らさない）', () => {
    const captured = captureProcessOutput()
    try {
      writeStructuredLogToStderr('{"application":"automation"}')

      expect(captured.stderr).toEqual(['{"application":"automation"}\n'])
      expect(captured.stdout).toEqual([])
    } finally {
      captured.restore()
    }
  })
})
