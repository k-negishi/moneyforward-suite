import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  ApplicationResult,
  ErrorCode,
  LoggerPort,
  MoneyForwardPort,
  RefreshAccountsOutcome,
  Result,
  SessionVerification,
} from '@mf-suite/core'
import { isErrorCode } from '@mf-suite/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  RefreshAccountsCliDependencies,
  RefreshAccountsCliOptions,
} from '../src/cli/refresh-accounts-cli.js'
import {
  parseRefreshAccountsArgs,
  REFRESH_ACCOUNTS_EXIT_CODE_BY_ERROR_CODE,
  REFRESH_ACCOUNTS_EXIT_CODE_BY_STATUS,
  REFRESH_ACCOUNTS_USAGE,
  runRefreshAccounts,
  toExitCode,
} from '../src/cli/refresh-accounts-cli.js'
import { createLocalAutomation } from '../src/composition-root.js'

/**
 * refresh-accounts CLI の検証。引数の allow list、status / errorCode から終了コードへの
 * 写像（全語彙）、出力の契約、Composition Root との組み立てを、fake 依存と合成データだけで
 * 固定する。実ブラウザ・実サービスには接続しない（SESSION_MISSING の経路ではブラウザを
 * 起動しないことまで含めて確認する）。
 */

/** errorCode の全語彙（写像テストの基準。追加時はこの一覧と期待値も更新する）。 */
const ALL_ERROR_CODES: readonly ErrorCode[] = [
  'AUTH_REQUIRED',
  'SESSION_MISSING',
  'SESSION_INVALID',
  'INVALID_JOB',
  'TARGET_NOT_FOUND',
  'TARGET_AMBIGUOUS',
  'REFRESH_REJECTED',
  'REFRESH_NOT_ACCEPTED',
  'TEMPORARY_FAILURE',
  'SECRET_NOT_FOUND',
  'SECRET_INVALID',
  'ACCESS_DENIED',
  'UNKNOWN',
]

/** 出力と引数・呼び出しを記録するテスト用の CLI 組み立て。 */
interface RecordedCli {
  readonly dependencies: RefreshAccountsCliDependencies
  readonly stdout: string[]
  readonly stderr: string[]
  readonly handledEvents: unknown[]
  readonly receivedOptions: RefreshAccountsCliOptions[]
  readonly createHandlerCalls: () => number
}

/**
 * 固定の Application Result（またはその非同期ハンドラ）を返す CLI 依存を組み立てる。
 * createHandler の呼び出し・Handler への入力・出力を記録し、テストが契約を検査できるようにする。
 */
const createCli = (result: ApplicationResult | (() => Promise<ApplicationResult>)): RecordedCli => {
  const stdout: string[] = []
  const stderr: string[] = []
  const handledEvents: unknown[] = []
  const receivedOptions: RefreshAccountsCliOptions[] = []
  let createHandlerCalls = 0
  const handle = typeof result === 'function' ? result : () => Promise.resolve(result)

  return {
    stdout,
    stderr,
    handledEvents,
    receivedOptions,
    createHandlerCalls: () => createHandlerCalls,
    dependencies: {
      createHandler: (options) => {
        createHandlerCalls += 1
        receivedOptions.push(options)
        return (event: unknown) => {
          handledEvents.push(event)
          return handle()
        }
      },
      writeStdout: (line) => {
        stdout.push(line)
      },
      writeStderr: (line) => {
        stderr.push(line)
      },
    },
  }
}

describe('parseRefreshAccountsArgs', () => {
  it('引数なしは headless（既定）', () => {
    expect(parseRefreshAccountsArgs([])).toEqual({ headless: true })
  })

  it('--headed で headed になる', () => {
    expect(parseRefreshAccountsArgs(['--headed'])).toEqual({ headless: false })
  })

  it('--headless で headless のままになる', () => {
    expect(parseRefreshAccountsArgs(['--headless'])).toEqual({ headless: true })
  })

  it.each([
    ['--execute'],
    ['--url'],
    ['--selector'],
    ['--foo'],
    ['--headed=true'],
    ['--headless=false'],
    ['https://example.invalid/'],
    ['refresh-accounts'],
    ['2'],
  ])('許可しない引数 %s を拒否する', (arg) => {
    expect(parseRefreshAccountsArgs([arg])).toBeNull()
  })

  it.each([
    [['--headed', '--headed']],
    [['--headless', '--headless']],
    [['--headed', '--headless']],
    [['--headless', '--headed']],
  ])('重複・同時指定（%s）を拒否する', (argv) => {
    expect(parseRefreshAccountsArgs(argv)).toBeNull()
  })
})

describe('終了コード', () => {
  it('成功系は 0 = 成功、4 = 部分成功、3 = 更新不要', () => {
    expect(REFRESH_ACCOUNTS_EXIT_CODE_BY_STATUS.SUCCESS).toBe(0)
    expect(REFRESH_ACCOUNTS_EXIT_CODE_BY_STATUS.PARTIAL_SUCCESS).toBe(4)
    expect(REFRESH_ACCOUNTS_EXIT_CODE_BY_STATUS.NO_REFRESH_NEEDED).toBe(3)
  })

  it.each([
    ['AUTH_REQUIRED', 2],
    ['SESSION_MISSING', 2],
    ['SESSION_INVALID', 2],
    ['INVALID_JOB', 64],
    ['TARGET_NOT_FOUND', 1],
    ['TARGET_AMBIGUOUS', 1],
    ['REFRESH_REJECTED', 1],
    ['REFRESH_NOT_ACCEPTED', 1],
    ['TEMPORARY_FAILURE', 1],
    ['SECRET_NOT_FOUND', 1],
    ['SECRET_INVALID', 1],
    ['ACCESS_DENIED', 1],
    ['UNKNOWN', 1],
  ] as const)('errorCode %s は終了コード %d（FAILURE の写像）', (errorCode, expected) => {
    expect(REFRESH_ACCOUNTS_EXIT_CODE_BY_ERROR_CODE[errorCode]).toBe(expected)
    expect(toExitCode({ status: 'FAILURE', errorCode })).toBe(expected)
  })

  it('写像のキーが ErrorCode の全語彙と一致する（追加漏れ・余剰の検出）', () => {
    const keys = Object.keys(REFRESH_ACCOUNTS_EXIT_CODE_BY_ERROR_CODE)
    expect(keys.every((key) => isErrorCode(key))).toBe(true)
    expect(keys.sort((a, b) => a.localeCompare(b))).toEqual(
      [...ALL_ERROR_CODES].sort((a, b) => a.localeCompare(b)),
    )
  })
})

describe('runRefreshAccounts', () => {
  it.each([
    ['SUCCESS', 0],
    ['PARTIAL_SUCCESS', 4],
    ['NO_REFRESH_NEEDED', 3],
  ] as const)('status %s は終了コード %d で status 行だけを出す', async (status, expected) => {
    const cli = createCli({ status })

    const exitCode = await runRefreshAccounts(cli.dependencies, [])

    expect(exitCode).toBe(expected)
    expect(cli.stdout).toEqual([`status=${status}`])
    expect(cli.stderr).toEqual([])
  })

  it.each(ALL_ERROR_CODES)(
    'FAILURE（errorCode %s）は対応表の終了コードで停止する',
    async (errorCode) => {
      const cli = createCli({ status: 'FAILURE', errorCode })

      const exitCode = await runRefreshAccounts(cli.dependencies, [])

      expect(exitCode).toBe(REFRESH_ACCOUNTS_EXIT_CODE_BY_ERROR_CODE[errorCode])
      expect(cli.stdout).toEqual([`status=FAILURE errorCode=${errorCode}`])
      expect(cli.stderr).toEqual([])
    },
  )

  it('Handler へ渡す入力は job だけ（attempt は Job Router の既定に任せる）', async () => {
    const cli = createCli({ status: 'SUCCESS' })

    await runRefreshAccounts(cli.dependencies, [])

    expect(cli.handledEvents).toEqual([{ job: 'refresh-accounts' }])
  })

  it('--headed は createHandler へ headless: false として渡る', async () => {
    const cli = createCli({ status: 'SUCCESS' })

    await runRefreshAccounts(cli.dependencies, ['--headed'])

    expect(cli.receivedOptions).toEqual([{ headless: false }])
  })

  it('既定は headless: true で組み立てる', async () => {
    const cli = createCli({ status: 'SUCCESS' })

    await runRefreshAccounts(cli.dependencies, [])

    expect(cli.receivedOptions).toEqual([{ headless: true }])
  })

  it('不正な引数は Handler を組み立てずに 64 で停止し、使い方を stderr に出す', async () => {
    const cli = createCli({ status: 'SUCCESS' })

    const exitCode = await runRefreshAccounts(cli.dependencies, [
      '--url',
      'https://example.invalid/',
    ])

    expect(exitCode).toBe(64)
    expect(cli.createHandlerCalls()).toBe(0)
    expect(cli.stdout).toEqual(['status=FAILURE errorCode=INVALID_JOB'])
    expect(cli.stderr).toEqual([REFRESH_ACCOUNTS_USAGE])
  })

  it('createHandler の例外は UNKNOWN（1）へ写し、例外メッセージを出さない', async () => {
    const marker = 'SYNTHETIC_ERROR_MUST_NOT_LEAK'
    const cli = createCli({ status: 'SUCCESS' })
    const dependencies: RefreshAccountsCliDependencies = {
      ...cli.dependencies,
      createHandler: () => {
        throw new Error(marker)
      },
    }

    const exitCode = await runRefreshAccounts(dependencies, [])

    expect(exitCode).toBe(1)
    expect(cli.stdout).toEqual(['status=FAILURE errorCode=UNKNOWN'])
    expect([...cli.stdout, ...cli.stderr].join('\n')).not.toContain(marker)
  })

  it('Handler の例外は UNKNOWN（1）へ写し、例外メッセージを出さない', async () => {
    const marker = 'SYNTHETIC_ERROR_MUST_NOT_LEAK'
    const cli = createCli(() => Promise.reject(new Error(marker)))

    const exitCode = await runRefreshAccounts(cli.dependencies, [])

    expect(exitCode).toBe(1)
    expect(cli.stdout).toEqual(['status=FAILURE errorCode=UNKNOWN'])
    expect([...cli.stdout, ...cli.stderr].join('\n')).not.toContain(marker)
  })
})

describe('Composition Root 経由の組み立て', () => {
  const SyntheticSessionState = {
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

  /** セッションの一括更新が受理された観測結果（Use Case が SUCCESS へ写す）。 */
  const AcceptedOutcome: RefreshAccountsOutcome = {
    acceptance: 'ACCEPTED',
    evidence: {
      observedRowCount: 1,
      changedRowCount: 1,
      failedRowCount: 0,
      inProgressAppeared: false,
    },
    authLost: false,
  }

  /** 呼び出し回数を記録する fake MoneyForwardPort（実ブラウザの代わり）。 */
  const createMoneyForward = (): {
    readonly port: MoneyForwardPort
    readonly verifyCalls: () => number
    readonly refreshCalls: () => number
  } => {
    let verifyCalls = 0
    let refreshCalls = 0
    return {
      port: {
        verifySession(): Promise<SessionVerification> {
          verifyCalls += 1
          return Promise.resolve('VALID')
        },
        refreshAccounts(): Promise<Result<RefreshAccountsOutcome>> {
          refreshCalls += 1
          return Promise.resolve({ ok: true, value: AcceptedOutcome })
        },
      },
      verifyCalls: () => verifyCalls,
      refreshCalls: () => refreshCalls,
    }
  }

  /** 何も出力しない fake LoggerPort（構造化ロガーの代わり）。 */
  const createSilentLogger = (): LoggerPort => ({ log: () => undefined })

  let workDirectory: string

  beforeEach(() => {
    workDirectory = mkdtempSync(join(tmpdir(), 'mf-refresh-cli-test-'))
  })

  afterEach(() => {
    rmSync(workDirectory, { recursive: true, force: true })
  })

  /** 合成データのセッションファイルを 0600 で作る（権限検査を通す）。 */
  const writeSyntheticSessionFile = (content: string): string => {
    const filePath = join(workDirectory, 'session.json')
    writeFileSync(filePath, content, { mode: 0o600 })
    chmodSync(filePath, 0o600)
    return filePath
  }

  it('実 Composition Root + fake Port で成功経路を通し、status 行だけを出す', async () => {
    const filePath = writeSyntheticSessionFile(JSON.stringify(SyntheticSessionState))
    const moneyForward = createMoneyForward()
    const stdout: string[] = []
    const stderr: string[] = []

    const exitCode = await runRefreshAccounts(
      {
        createHandler: (options) =>
          createLocalAutomation(
            { headless: options.headless, sessionFilePath: filePath },
            { moneyForward: moneyForward.port, logger: createSilentLogger() },
          ),
        writeStdout: (line) => {
          stdout.push(line)
        },
        writeStderr: (line) => {
          stderr.push(line)
        },
      },
      [],
    )

    expect(exitCode).toBe(0)
    expect(stdout).toEqual(['status=SUCCESS'])
    expect(stderr).toEqual([])
    expect(moneyForward.verifyCalls()).toBe(1)
    expect(moneyForward.refreshCalls()).toBe(1)
  })

  it('SESSION_MISSING のスモーク: 実 Composition Root で終了コード 2、ブラウザへ触れない', async () => {
    const stdout: string[] = []
    const stderr: string[] = []

    const exitCode = await runRefreshAccounts(
      {
        // 実 Adapter を含む Composition Root を組み立てる（存在しないセッションパスを読ませる）。
        createHandler: (options) =>
          createLocalAutomation({
            headless: options.headless,
            sessionFilePath: join(workDirectory, 'not-created.json'),
          }),
        writeStdout: (line) => {
          stdout.push(line)
        },
        writeStderr: (line) => {
          stderr.push(line)
        },
      },
      [],
    )

    expect(exitCode).toBe(2)
    expect(stdout).toEqual(['status=FAILURE errorCode=SESSION_MISSING'])
    expect(stderr).toEqual([])
  })

  it('SESSION_MISSING では Use Case（Adapter のブラウザ操作）を呼ばない', async () => {
    const moneyForward = createMoneyForward()
    const stdout: string[] = []

    const exitCode = await runRefreshAccounts(
      {
        createHandler: (options) =>
          createLocalAutomation(
            {
              headless: options.headless,
              sessionFilePath: join(workDirectory, 'not-created.json'),
            },
            { moneyForward: moneyForward.port, logger: createSilentLogger() },
          ),
        writeStdout: (line) => {
          stdout.push(line)
        },
        writeStderr: () => undefined,
      },
      [],
    )

    expect(exitCode).toBe(2)
    expect(stdout).toEqual(['status=FAILURE errorCode=SESSION_MISSING'])
    expect(moneyForward.verifyCalls()).toBe(0)
    expect(moneyForward.refreshCalls()).toBe(0)
  })

  it('セッションが壊れている場合は SESSION_INVALID で終了コード 2', async () => {
    const filePath = writeSyntheticSessionFile('{"cookies": [')
    const moneyForward = createMoneyForward()
    const stdout: string[] = []

    const exitCode = await runRefreshAccounts(
      {
        createHandler: (options) =>
          createLocalAutomation(
            { headless: options.headless, sessionFilePath: filePath },
            { moneyForward: moneyForward.port, logger: createSilentLogger() },
          ),
        writeStdout: (line) => {
          stdout.push(line)
        },
        writeStderr: () => undefined,
      },
      [],
    )

    expect(exitCode).toBe(2)
    expect(stdout).toEqual(['status=FAILURE errorCode=SESSION_INVALID'])
    expect(moneyForward.verifyCalls()).toBe(0)
  })
})
