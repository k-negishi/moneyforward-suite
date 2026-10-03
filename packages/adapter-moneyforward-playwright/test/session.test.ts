import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readSessionFile, saveSessionState } from '../src/spike/session.js'
import type { StorageState } from '../src/spike/session.js'

// 一時ディレクトリだけで検証する（実際の .local/ には触れない）。中身は合成データのみ。
describe('session の保存と読込', () => {
  let workDirectory: string

  beforeEach(() => {
    workDirectory = mkdtempSync(join(tmpdir(), 'mf-session-test-'))
  })

  afterEach(() => {
    rmSync(workDirectory, { recursive: true, force: true })
  })

  const syntheticStorageState: StorageState = {
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

  it('ファイルが無い場合は SESSION_MISSING を返す', () => {
    const result = readSessionFile(join(workDirectory, 'not-created.json'))

    expect(result).toEqual({ status: 'SESSION_MISSING' })
  })

  it('JSON として壊れている場合は SESSION_INVALID を返す', () => {
    const filePath = join(workDirectory, 'broken.json')
    writeFileSync(filePath, '{"cookies": [')
    // 保存側と同じ 0600 に整え、権限検査ではなく内容検証の経路を通す。
    chmodSync(filePath, 0o600)

    const result = readSessionFile(filePath)

    expect(result).toEqual({ status: 'SESSION_INVALID' })
  })

  it('storageState の形を満たさない JSON は SESSION_INVALID を返す', () => {
    const filePath = join(workDirectory, 'wrong-shape.json')
    writeFileSync(filePath, JSON.stringify({ cookies: {}, origins: [] }))
    chmodSync(filePath, 0o600)

    const result = readSessionFile(filePath)

    expect(result).toEqual({ status: 'SESSION_INVALID' })
  })

  it('cookies / origins の要素がオブジェクトでない場合は SESSION_INVALID を返す', () => {
    const cases = [
      { cookies: [1], origins: [] },
      { cookies: [], origins: ['not-an-object'] },
      { cookies: [null], origins: [] },
      { cookies: [], origins: [['nested']] },
    ]

    for (const [index, value] of cases.entries()) {
      const filePath = join(workDirectory, `element-shape-${index}.json`)
      writeFileSync(filePath, JSON.stringify(value))
      chmodSync(filePath, 0o600)

      expect(readSessionFile(filePath)).toEqual({ status: 'SESSION_INVALID' })
    }
  })

  it('保存した storageState を読み戻せる', () => {
    const filePath = join(workDirectory, '.local', 'moneyforward-session.json')
    saveSessionState(filePath, syntheticStorageState)

    const result = readSessionFile(filePath)

    expect(result).toEqual({ status: 'OK', storageState: syntheticStorageState })
  })

  it.skipIf(process.platform === 'win32')('保存時にディレクトリを 0700・ファイルを 0600 にする', () => {
    const directory = join(workDirectory, '.local')
    const filePath = join(directory, 'moneyforward-session.json')
    saveSessionState(filePath, syntheticStorageState)

    expect(statSync(directory).mode & 0o777).toBe(0o700)
    expect(statSync(filePath).mode & 0o777).toBe(0o600)
  })

  it.skipIf(process.platform === 'win32')('既存ファイルの権限が緩い場合も 0600 に締める', () => {
    const filePath = join(workDirectory, 'moneyforward-session.json')
    writeFileSync(filePath, '{}', { mode: 0o644 })

    saveSessionState(filePath, syntheticStorageState)

    expect(statSync(filePath).mode & 0o777).toBe(0o600)
  })

  it.skipIf(process.platform === 'win32')('既存ディレクトリの権限は変更しない', () => {
    const directory = join(workDirectory, 'existing')
    const filePath = join(directory, 'moneyforward-session.json')
    // MF_SESSION_FILE で任意のディレクトリを指定できるため、既存の権限を勝手に変えない。
    mkdirSync(directory, { recursive: true })
    chmodSync(directory, 0o755)

    saveSessionState(filePath, syntheticStorageState)

    expect(statSync(directory).mode & 0o777).toBe(0o755)
    expect(statSync(filePath).mode & 0o777).toBe(0o600)
  })

  it.skipIf(process.platform === 'win32')(
    'group / other に読み取り権があるファイルは、内容を読まずに SESSION_INVALID を返す',
    () => {
      const filePath = join(workDirectory, 'too-open.json')
      // 内容が正しい storageState でも、他ユーザーが読める権限なら fail closed で拒否する。
      writeFileSync(filePath, JSON.stringify(syntheticStorageState))
      chmodSync(filePath, 0o644)

      expect(readSessionFile(filePath)).toEqual({ status: 'SESSION_INVALID' })
    },
  )

  it.skipIf(process.platform === 'win32')('0600 のファイルは通常どおり読み込める', () => {
    const filePath = join(workDirectory, 'owner-only.json')
    writeFileSync(filePath, JSON.stringify(syntheticStorageState))
    chmodSync(filePath, 0o600)

    expect(readSessionFile(filePath)).toEqual({ status: 'OK', storageState: syntheticStorageState })
  })

  it('保存後に一時ファイル（.tmp）が残らない', () => {
    const filePath = join(workDirectory, '.local', 'moneyforward-session.json')
    saveSessionState(filePath, syntheticStorageState)

    expect(existsSync(`${filePath}.tmp`)).toBe(false)
    expect(readdirSync(join(workDirectory, '.local'))).toEqual(['moneyforward-session.json'])
  })

  it.skipIf(process.platform === 'win32')(
    '予測可能な一時パス（.tmp）に symlink を置かれても、参照先のファイルへ書き込まない',
    () => {
      const filePath = join(workDirectory, 'moneyforward-session.json')
      const victimPath = join(workDirectory, 'victim.txt')
      writeFileSync(victimPath, 'victim-content')
      // 予測可能な一時パスを狙い、参照先のファイルを Secret で上書きさせる攻撃を再現する。
      symlinkSync(victimPath, `${filePath}.tmp`)

      saveSessionState(filePath, syntheticStorageState)

      expect(readFileSync(victimPath, 'utf8')).toBe('victim-content')
      expect(readSessionFile(filePath)).toEqual({
        status: 'OK',
        storageState: syntheticStorageState,
      })
    },
  )
})
