import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SessionVerification } from '@mf-suite/core'
import type { SessionState } from '@mf-suite/security'
import { readSessionFile, saveSessionState } from '@mf-suite/security'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runSessionCheck, SESSION_REGENERATE_GUIDANCE } from '../src/cli/session-cli.js'

// session:check の実行本体を、実ファイルシステム（一時ディレクトリ）と合成セッションで検証する。
// 検証（verifySession）は合成実装を注入し、実サービス・実ブラウザへは接続しない。
describe('runSessionCheck', () => {
  let workDirectory: string
  let sessionFilePath: string

  const syntheticCookieValue = 'synthetic-cookie-value'

  const syntheticSessionState: SessionState = {
    cookies: [
      {
        name: 'synthetic_cookie',
        value: syntheticCookieValue,
        domain: 'example.invalid',
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ],
    origins: [],
  }

  beforeEach(() => {
    workDirectory = mkdtempSync(join(tmpdir(), 'mf-session-cli-test-'))
    sessionFilePath = join(workDirectory, 'moneyforward-session.json')
  })

  afterEach(() => {
    rmSync(workDirectory, { recursive: true, force: true })
  })

  const runCheck = async (
    verification: SessionVerification = 'UNKNOWN',
  ): Promise<{
    readonly exitCode: number
    readonly stdout: string[]
    readonly stderr: string[]
    readonly verifySession: ReturnType<typeof vi.fn>
  }> => {
    const stdout: string[] = []
    const stderr: string[] = []
    const verifySession = vi.fn(() => Promise.resolve(verification))

    const exitCode = await runSessionCheck({
      resolveSessionFilePath: () => sessionFilePath,
      readSessionFile,
      verifySession,
      writeStdout: (line) => {
        stdout.push(line)
      },
      writeStderr: (line) => {
        stderr.push(line)
      },
    })

    return { exitCode, stdout, stderr, verifySession }
  }

  it('欠如 → SESSION_MISSING で 1、検証（ブラウザ起動）を行わない', async () => {
    const { exitCode, stdout, stderr, verifySession } = await runCheck()

    expect(exitCode).toBe(1)
    expect(stdout).toEqual(['status=SESSION_MISSING'])
    expect(stderr).toEqual([SESSION_REGENERATE_GUIDANCE])
    expect(verifySession).not.toHaveBeenCalled()
  })

  it('破損（JSON でない）→ SESSION_INVALID で 1、検証を行わない', async () => {
    writeFileSync(sessionFilePath, '{"cookies": [')
    chmodSync(sessionFilePath, 0o600)

    const { exitCode, stdout, stderr, verifySession } = await runCheck()

    expect(exitCode).toBe(1)
    expect(stdout).toEqual(['status=SESSION_INVALID'])
    expect(stderr).toEqual([SESSION_REGENERATE_GUIDANCE])
    expect(verifySession).not.toHaveBeenCalled()
  })

  it('他ユーザーが読める権限のファイルは SESSION_INVALID（fail closed）', async () => {
    saveSessionState(sessionFilePath, syntheticSessionState)
    chmodSync(sessionFilePath, 0o644)

    const { exitCode, stdout, verifySession } = await runCheck()

    expect(exitCode).toBe(1)
    expect(stdout).toEqual(['status=SESSION_INVALID'])
    expect(verifySession).not.toHaveBeenCalled()
  })

  it('失効 → AUTH_REQUIRED で 2、再生成を案内する（保存先やセッション値は出さない）', async () => {
    saveSessionState(sessionFilePath, syntheticSessionState)

    const { exitCode, stdout, stderr } = await runCheck('AUTH_REQUIRED')

    expect(exitCode).toBe(2)
    expect(stdout).toEqual(['status=AUTH_REQUIRED'])
    expect(stderr).toEqual([SESSION_REGENERATE_GUIDANCE])
  })

  it('有効 → SESSION_VALID で 0、保存先を表示する', async () => {
    saveSessionState(sessionFilePath, syntheticSessionState)

    const { exitCode, stdout, stderr, verifySession } = await runCheck('VALID')

    expect(exitCode).toBe(0)
    expect(stdout).toEqual(['status=SESSION_VALID', 'session ファイル: moneyforward-session.json'])
    expect(stderr).toEqual([])
    expect(verifySession).toHaveBeenCalledTimes(1)
  })

  it('判定不能（UNKNOWN）→ TEMPORARY_FAILURE で 1（有効・失効と決めない）', async () => {
    saveSessionState(sessionFilePath, syntheticSessionState)

    const { exitCode, stdout, stderr } = await runCheck('UNKNOWN')

    expect(exitCode).toBe(1)
    expect(stdout).toEqual(['status=TEMPORARY_FAILURE'])
    expect(stderr).toEqual([])
  })

  it('検証の例外（内容を持ち得る）を出力せず TEMPORARY_FAILURE で 1 を返す', async () => {
    saveSessionState(sessionFilePath, syntheticSessionState)

    const stdout: string[] = []
    const stderr: string[] = []
    const exitCode = await runSessionCheck({
      resolveSessionFilePath: () => sessionFilePath,
      readSessionFile,
      verifySession: () => Promise.reject(new Error(syntheticCookieValue)),
      writeStdout: (line) => {
        stdout.push(line)
      },
      writeStderr: (line) => {
        stderr.push(line)
      },
    })

    expect(exitCode).toBe(1)
    expect(stdout).toEqual(['status=TEMPORARY_FAILURE'])
    expect(stdout.join('\n')).not.toContain(syntheticCookieValue)
    expect(stderr).toEqual([])
  })

  it('保存成功時の権限はファイル 0600・新規ディレクトリ 0700（CLI が経由する保存経路の固定）', () => {
    // 権限の網羅（既存ファイルの締め直し・symlink 対策など）は security の session-file テストが担う。
    // ここでは CLI が保存に使う saveSessionState の権限を 1 件だけ固定する。
    const nestedDirectory = join(workDirectory, 'nested')
    const nestedFilePath = join(nestedDirectory, 'moneyforward-session.json')

    saveSessionState(nestedFilePath, syntheticSessionState)

    expect(statSync(nestedDirectory).mode & 0o777).toBe(0o700)
    expect(statSync(nestedFilePath).mode & 0o777).toBe(0o600)
  })

  it('上書きは置換で、古いセッションの値を残さない', () => {
    saveSessionState(sessionFilePath, syntheticSessionState)
    const replacement: SessionState = { cookies: [], origins: [] }

    saveSessionState(sessionFilePath, replacement)

    const result = readSessionFile(sessionFilePath)
    expect(result).toEqual({ status: 'OK', sessionState: replacement })
  })

  it('どの出力にもセッションの値（Cookie の名前・値）を出さない', async () => {
    saveSessionState(sessionFilePath, syntheticSessionState)

    for (const verification of ['VALID', 'AUTH_REQUIRED', 'UNKNOWN'] as const) {
      const { stdout, stderr } = await runCheck(verification)
      const output = [...stdout, ...stderr].join('\n')

      expect(output).not.toContain(syntheticCookieValue)
      expect(output).not.toContain('synthetic_cookie')
    }
  })
})
