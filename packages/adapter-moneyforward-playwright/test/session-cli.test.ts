import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { SessionState } from '@mf-suite/security'
import { describe, expect, it } from 'vitest'
import type { SessionLoginDependencies } from '../src/cli/session-cli.js'
import {
  runSessionLogin,
  SESSION_CHECK_EXIT_CODE_BY_STATUS,
  SESSION_LOGIN_CHALLENGE_NOTICE,
  SESSION_LOGIN_ENTER_PROMPT,
  SESSION_LOGIN_EXIT_CODE_BY_STATUS,
  SESSION_LOGIN_INSTRUCTION,
  SESSION_REGENERATE_GUIDANCE,
  toSessionCheckStatus,
  toSessionLoginStatus,
} from '../src/cli/session-cli.js'
import type { LoginSessionResult } from '../src/moneyforward/page-client.js'

// セッション CLI の語彙・終了コード・案内文言と、手動ログインの実行（合成依存）を検証する。
// 実ブラウザ・実サービスには触れない（保存の判断は page-client 側のテストが担う）。
const syntheticSessionState: SessionState = {
  cookies: [
    {
      name: 'synthetic_cookie',
      value: 'synthetic_value',
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

describe('toSessionLoginStatus', () => {
  it.each([['SESSION_SAVED'], ['AUTH_REQUIRED'], ['TEMPORARY_FAILURE']] as const)(
    '%s はそのまま写す',
    (status) => {
      expect(toSessionLoginStatus({ status })).toBe(status)
    },
  )

  it('NOT_COMPLETED は AUTH_REQUIRED に写す（未完了を保存成功にしない）', () => {
    expect(toSessionLoginStatus({ status: 'NOT_COMPLETED' })).toBe('AUTH_REQUIRED')
  })
})

describe('toSessionCheckStatus', () => {
  it('読込 OK + VALID は SESSION_VALID', () => {
    expect(
      toSessionCheckStatus({ status: 'OK', sessionState: syntheticSessionState }, 'VALID'),
    ).toBe('SESSION_VALID')
  })

  it('読込 OK + AUTH_REQUIRED は AUTH_REQUIRED（失効）', () => {
    expect(
      toSessionCheckStatus({ status: 'OK', sessionState: syntheticSessionState }, 'AUTH_REQUIRED'),
    ).toBe('AUTH_REQUIRED')
  })

  it('読込 OK + UNKNOWN は TEMPORARY_FAILURE（判定不能を有効・失効と決めない）', () => {
    expect(
      toSessionCheckStatus({ status: 'OK', sessionState: syntheticSessionState }, 'UNKNOWN'),
    ).toBe('TEMPORARY_FAILURE')
  })

  it('欠如は検証結果によらず SESSION_MISSING', () => {
    expect(toSessionCheckStatus({ status: 'SESSION_MISSING' }, 'VALID')).toBe('SESSION_MISSING')
  })

  it('破損は検証結果によらず SESSION_INVALID', () => {
    expect(toSessionCheckStatus({ status: 'SESSION_INVALID' }, 'AUTH_REQUIRED')).toBe(
      'SESSION_INVALID',
    )
  })
})

describe('終了コード', () => {
  it('session:login は 0 = 保存成功、2 = 認証が必要、1 = その他', () => {
    expect(SESSION_LOGIN_EXIT_CODE_BY_STATUS.SESSION_SAVED).toBe(0)
    expect(SESSION_LOGIN_EXIT_CODE_BY_STATUS.AUTH_REQUIRED).toBe(2)
    expect(SESSION_LOGIN_EXIT_CODE_BY_STATUS.TEMPORARY_FAILURE).toBe(1)
  })

  it('session:check は 0 = 有効、2 = 失効、1 = 欠如・破損・判定不能', () => {
    expect(SESSION_CHECK_EXIT_CODE_BY_STATUS.SESSION_VALID).toBe(0)
    expect(SESSION_CHECK_EXIT_CODE_BY_STATUS.AUTH_REQUIRED).toBe(2)
    expect(SESSION_CHECK_EXIT_CODE_BY_STATUS.SESSION_MISSING).toBe(1)
    expect(SESSION_CHECK_EXIT_CODE_BY_STATUS.SESSION_INVALID).toBe(1)
    expect(SESSION_CHECK_EXIT_CODE_BY_STATUS.TEMPORARY_FAILURE).toBe(1)
  })

  it('session:check はすべての状態に終了コードを持つ', () => {
    expect(
      Object.keys(SESSION_CHECK_EXIT_CODE_BY_STATUS).sort((a, b) => a.localeCompare(b)),
    ).toEqual(
      [
        'AUTH_REQUIRED',
        'SESSION_INVALID',
        'SESSION_MISSING',
        'SESSION_VALID',
        'TEMPORARY_FAILURE',
      ].sort((a, b) => a.localeCompare(b)),
    )
  })
})

describe('案内文言', () => {
  it('再生成の案内は session:login のコマンドを含む固定文言', () => {
    expect(SESSION_REGENERATE_GUIDANCE).toContain(
      'pnpm --filter @mf-suite/adapter-moneyforward-playwright session:login',
    )
  })

  it('再生成の案内は 1 行で改行を含まない', () => {
    expect(SESSION_REGENERATE_GUIDANCE).not.toContain('\n')
  })
})

describe('runSessionLogin', () => {
  const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
  const sessionFilePath = join(repositoryRoot, '.local', 'moneyforward-session.json')

  const createDependencies = (
    result: LoginSessionResult,
  ): {
    readonly dependencies: SessionLoginDependencies
    readonly stdout: string[]
    readonly stderr: string[]
  } => {
    const stdout: string[] = []
    const stderr: string[] = []
    return {
      stdout,
      stderr,
      dependencies: {
        resolveSessionFilePath: () => sessionFilePath,
        runManualLogin: () => Promise.resolve(result),
        waitForEnter: () => Promise.resolve(true),
        writeStdout: (line) => {
          stdout.push(line)
        },
        writeStderr: (line) => {
          stderr.push(line)
        },
      },
    }
  }

  it('SESSION_SAVED → status と保存先を stdout に出して 0', async () => {
    const { dependencies, stdout, stderr } = createDependencies({ status: 'SESSION_SAVED' })

    const exitCode = await runSessionLogin(dependencies)

    expect(exitCode).toBe(0)
    expect(stdout).toContain('status=SESSION_SAVED')
    expect(stdout).toContain('session ファイル: .local/moneyforward-session.json')
    expect(stderr).toEqual([])
  })

  it('NOT_COMPLETED → AUTH_REQUIRED で 2、再生成を案内する（保存成功の表示を出さない）', async () => {
    const { dependencies, stdout, stderr } = createDependencies({ status: 'NOT_COMPLETED' })

    const exitCode = await runSessionLogin(dependencies)

    expect(exitCode).toBe(2)
    expect(stdout).toEqual(['status=AUTH_REQUIRED'])
    expect(stderr).toEqual([SESSION_REGENERATE_GUIDANCE])
  })

  it('AUTH_REQUIRED → 2（チャレンジ検知・未認証でも保存の表示を出さない）', async () => {
    const { dependencies, stdout, stderr } = createDependencies({ status: 'AUTH_REQUIRED' })

    const exitCode = await runSessionLogin(dependencies)

    expect(exitCode).toBe(2)
    expect(stdout).toEqual(['status=AUTH_REQUIRED'])
    expect(stderr).toEqual([SESSION_REGENERATE_GUIDANCE])
  })

  it('TEMPORARY_FAILURE → 1（判定不能を保存成功にしない）', async () => {
    const { dependencies, stdout, stderr } = createDependencies({ status: 'TEMPORARY_FAILURE' })

    const exitCode = await runSessionLogin(dependencies)

    expect(exitCode).toBe(1)
    expect(stdout).toEqual(['status=TEMPORARY_FAILURE'])
    expect(stderr).toEqual([])
  })

  it('ログイン画面を開いた後の案内とプロンプトを待機に渡す', async () => {
    const stdout: string[] = []
    const prompts: string[] = []
    const dependencies: SessionLoginDependencies = {
      resolveSessionFilePath: () => sessionFilePath,
      runManualLogin: async (_sessionFilePath, waitForLogin) => {
        await waitForLogin()
        return { status: 'SESSION_SAVED' }
      },
      waitForEnter: (message) => {
        prompts.push(message)
        expect(stdout).toContain(SESSION_LOGIN_INSTRUCTION)
        expect(stdout).toContain(SESSION_LOGIN_CHALLENGE_NOTICE)
        return Promise.resolve(true)
      },
      writeStdout: (line) => {
        stdout.push(line)
      },
      writeStderr: () => undefined,
    }

    await runSessionLogin(dependencies)

    expect(prompts).toEqual([SESSION_LOGIN_ENTER_PROMPT])
  })

  it('例外の内容を出力せず TEMPORARY_FAILURE で 1 を返す', async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    const dependencies: SessionLoginDependencies = {
      resolveSessionFilePath: () => {
        throw new Error('synthetic-exception-value')
      },
      runManualLogin: () => Promise.resolve<LoginSessionResult>({ status: 'SESSION_SAVED' }),
      waitForEnter: () => Promise.resolve(true),
      writeStdout: (line) => {
        stdout.push(line)
      },
      writeStderr: (line) => {
        stderr.push(line)
      },
    }

    const exitCode = await runSessionLogin(dependencies)

    expect(exitCode).toBe(1)
    expect(stdout).toEqual(['status=TEMPORARY_FAILURE'])
    expect(stdout.join('\n')).not.toContain('synthetic-exception-value')
    expect(stderr).toEqual([])
  })
})
