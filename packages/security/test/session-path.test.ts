import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import {
  SESSION_FILE_ENV_VAR,
  formatSessionPathForDisplay,
  resolveSessionFilePath,
} from '../src/session/session-path.js'

// 一時パスのみを使う（実際の .local/ には触れない）。
describe('resolveSessionFilePath', () => {
  const originalValue = process.env[SESSION_FILE_ENV_VAR]

  afterEach(() => {
    if (originalValue === undefined) delete process.env[SESSION_FILE_ENV_VAR]
    else process.env[SESSION_FILE_ENV_VAR] = originalValue
  })

  it('MF_SESSION_FILE が絶対パスならそれを優先する', () => {
    const absolutePath = join(tmpdir(), 'mf-session-override.json')
    process.env[SESSION_FILE_ENV_VAR] = absolutePath

    expect(resolveSessionFilePath()).toBe(absolutePath)
  })

  it('MF_SESSION_FILE が相対パスならエラーにする（cwd 依存の事故を防ぐ）', () => {
    process.env[SESSION_FILE_ENV_VAR] = join('relative', 'session.json')

    expect(() => resolveSessionFilePath()).toThrow()
  })

  it('MF_SESSION_FILE が未設定ならリポジトリ内の既定パスへフォールバックする', () => {
    delete process.env[SESSION_FILE_ENV_VAR]
    const filePath = resolveSessionFilePath()

    expect(isAbsolute(filePath)).toBe(true)
    expect(filePath.endsWith(join('.local', 'moneyforward-session.json'))).toBe(true)
  })
})

describe('formatSessionPathForDisplay', () => {
  // テストファイルの位置からリポジトリルートを特定する（実装と同じ目印を使う）。
  const repositoryRoot = ((): string => {
    let current = dirname(fileURLToPath(import.meta.url))
    for (;;) {
      if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current
      const parent = dirname(current)
      if (parent === current) throw new Error('リポジトリルートを特定できません')
      current = parent
    }
  })()

  it('リポジトリ内のパスはルート相対で表示する', () => {
    const filePath = join(repositoryRoot, '.local', 'moneyforward-session.json')

    expect(formatSessionPathForDisplay(filePath)).toBe(join('.local', 'moneyforward-session.json'))
  })

  it('リポジトリ外のパスはファイル名のみにする（ユーザー名等を出さない）', () => {
    const outsidePath = join(tmpdir(), 'mf-outside', 'moneyforward-session.json')

    expect(formatSessionPathForDisplay(outsidePath)).toBe('moneyforward-session.json')
  })
})
