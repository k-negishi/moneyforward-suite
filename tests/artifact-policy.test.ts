import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * Playwright Artifact（Screenshot / HTML / DOM Dump / HAR / Trace / Video）の非保存を、
 * ソースに有効化設定が存在しないことで検査する（ADR-0017）。
 * 実行時の抑止（launch / context の options builder とそのテスト）も必要で、
 * この静的な検査はその二重防御の 1 層。検出できるのはソース中の直接の記述だけで、
 * 変数へ組み立てて渡す場合やラッパー越しの設定までは防げない（それらはレビューで補う）。
 */

/** リポジトリのルート。cwd に依存せず、このテストファイルの位置（tests/）から解決する。 */
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/** 検査対象の拡張子（ソースコードのみ。コメント規約の走査対象より狭くする）。 */
const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'])

/**
 * 検査対象のソースディレクトリ（リポジトリルート相対）。
 * Playwright Adapter の src と、各アプリの src を対象にする。
 */
const targetSourceDirectories = (): string[] => {
  const directories = ['packages/adapter-moneyforward-playwright/src']
  for (const entry of readdirSync(join(repoRoot, 'apps'), { withFileTypes: true })) {
    if (entry.isDirectory()) directories.push(`apps/${entry.name}/src`)
  }
  return directories
}

/** ディレクトリ配下のソースファイル（リポジトリルート相対）を再帰的に集める。 */
const collectSourceFiles = (relativeDirectory: string): string[] => {
  const absoluteDirectory = join(repoRoot, relativeDirectory)
  if (!existsSync(absoluteDirectory) || !statSync(absoluteDirectory).isDirectory()) return []

  const files: string[] = []
  const walk = (relativePath: string): void => {
    for (const entry of readdirSync(join(repoRoot, relativePath), { withFileTypes: true })) {
      const childPath = `${relativePath}/${entry.name}`
      if (entry.isDirectory()) walk(childPath)
      else if (entry.isFile() && sourceExtensions.has(extname(entry.name).toLowerCase())) {
        files.push(childPath)
      }
    }
  }
  walk(relativeDirectory)
  return files
}

/**
 * 文字列 'off' を明示したときだけ無効とみなすオプション（Playwright の context options）。
 * それ以外の値（'on' / 'retain-on-failure' 等のリテラル・変数・式）は有効化として扱う。
 */
const toggleOptionNames = new Set(['trace', 'video', 'screenshot'])

/**
 * path / dir を要求する保存系オプション。記述があれば有効化として扱う。
 */
const pathOptionNames = new Set(['recordHar', 'recordVideo'])

const optionNames = new Set([...toggleOptionNames, ...pathOptionNames])

const quoteCharacters = new Set(['"', "'", '`'])

const isIdentifierStart = (ch: string): boolean => /[A-Za-z_$]/.test(ch)
const isIdentifierPart = (ch: string): boolean => /[A-Za-z0-9_$]/.test(ch)

/** 空白（スペース・タブ）を読み飛ばした次の位置を返す。 */
const skipSpaces = (line: string, start: number): number => {
  let i = start
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i += 1
  return i
}

/** クォート開始位置から文字列リテラルを読み飛ばし、次の位置を返す（閉じない場合は行末）。 */
const skipStringLiteral = (line: string, start: number): number => {
  const quote = line[start]
  let i = start + 1
  while (i < line.length) {
    if (line[i] === '\\') {
      i += 2
      continue
    }
    if (line[i] === quote) return i + 1
    i += 1
  }
  return i
}

/** バッククォート文字列の終端位置（閉じ位置の次）を探す。見つからなければ -1。 */
const findTemplateEnd = (line: string, start: number): number => {
  let i = start
  while (i < line.length) {
    if (line[i] === '\\') {
      i += 2
      continue
    }
    if (line[i] === '`') return i + 1
    i += 1
  }
  return -1
}

/** 位置 start が文字列リテラルの開始なら中身を返す。開始でなければ null。 */
const readStringLiteral = (line: string, start: number): string | null => {
  const quote = line[start] as string | undefined
  if (quote === undefined || !quoteCharacters.has(quote)) return null
  const end = skipStringLiteral(line, start)
  const closed = end - 1 > start && line[end - 1] === quote
  return closed ? line.slice(start + 1, end - 1) : line.slice(start + 1)
}

interface LineScanResult {
  readonly enablingOptionCount: number
  readonly inBlockComment: boolean
  readonly inTemplate: boolean
}

/**
 * 1 行を走査し、Artifact 保存を有効化するオプション指定の数を返す。
 * コメント（行・ブロック）と文字列リテラルの中身はコードとして解釈しない
 * （コメント内の言及を誤検出しない）。ブロックコメントと複数行テンプレートは行をまたぐため、
 * 状態を持ち越す。制限: テンプレートリテラルの補間の中身は文字列として扱う（検出しない）。
 */
const scanLine = (line: string, inBlockComment: boolean, inTemplate: boolean): LineScanResult => {
  let i = 0
  let count = 0
  let block = inBlockComment
  let template = inTemplate

  while (i < line.length) {
    if (template) {
      const end = findTemplateEnd(line, i)
      if (end === -1) return { enablingOptionCount: count, inBlockComment: block, inTemplate: true }
      template = false
      i = end
      continue
    }

    if (block) {
      const end = line.indexOf('*/', i)
      if (end === -1) return { enablingOptionCount: count, inBlockComment: true, inTemplate: false }
      block = false
      i = end + 2
      continue
    }

    const ch = line[i] as string
    if (ch === '/' && line[i + 1] === '*') {
      block = true
      i += 2
      continue
    }
    if (ch === '/' && line[i + 1] === '/') break // 行コメント（行末まで）
    if (ch === '`') {
      const end = findTemplateEnd(line, i + 1)
      if (end === -1) return { enablingOptionCount: count, inBlockComment: false, inTemplate: true }
      i = end
      continue
    }
    if (ch === '"' || ch === "'") {
      i = skipStringLiteral(line, i)
      continue
    }

    if (isIdentifierStart(ch)) {
      let end = i + 1
      while (end < line.length && isIdentifierPart(line[end] as string)) end += 1
      const name = line.slice(i, end)

      if (optionNames.has(name)) {
        const colon = skipSpaces(line, end)
        if (line[colon] === ':') {
          const valueStart = skipSpaces(line, colon + 1)
          const literal = readStringLiteral(line, valueStart)
          // 'off' の明示があるときだけ無効化とみなし、それ以外（'on' 等のリテラル・変数・式・
          // 行末で値が続く場合）は有効化として扱う（見逃しより誤検出側へ倒す）。
          // recordHar / recordVideo は値に path / dir を要求するため、記述があれば常に有効化。
          if (!(toggleOptionNames.has(name) && literal === 'off')) count += 1
        }
      }

      i = end
      continue
    }

    i += 1
  }

  return { enablingOptionCount: count, inBlockComment: block, inTemplate: template }
}

/** 行が有効化設定（コード部分）に一致するか。回帰防止の表から直接呼ぶ。 */
const isEnablingLine = (line: string): boolean =>
  scanLine(line, false, false).enablingOptionCount > 0

interface Violation {
  readonly path: string
  readonly line: number
}

/** 対象ファイルを走査し、違反した行を集める（行をまたぐコメント状態を持ち越す）。 */
const collectViolations = (filePaths: readonly string[]): Violation[] => {
  const violations: Violation[] = []

  for (const relativePath of filePaths) {
    const lines = readFileSync(join(repoRoot, relativePath), 'utf8').split(/\r?\n/)
    let inBlockComment = false
    let inTemplate = false

    lines.forEach((line, index) => {
      const result = scanLine(line, inBlockComment, inTemplate)
      inBlockComment = result.inBlockComment
      inTemplate = result.inTemplate
      if (result.enablingOptionCount > 0) violations.push({ path: relativePath, line: index + 1 })
    })
  }

  return violations
}

/**
 * 違反を `path:line` の形式で列挙した報告メッセージを組み立てる。
 * 行の内容は出力しない（機微情報がテスト・CI ログへ漏れ得るため。Minimal Logging 準拠）。
 */
const formatViolationReport = (violations: readonly Violation[]): string =>
  [
    `Playwright Artifact の有効化設定を ${violations.length} 件検出しました。`,
    'Screenshot / HTML / DOM Dump / HAR / Trace / Video は恒常保存しない（ADR-0017）。',
    '',
    ...violations.map((violation) => `${violation.path}:${violation.line}`),
  ].join('\n')

describe('Playwright Artifact の非保存（ソースの静的検査）', () => {
  it('adapter と apps のソースに Artifact 保存を有効化する設定が無い', () => {
    const targets = targetSourceDirectories().flatMap(collectSourceFiles)

    // 列挙の配線が壊れて対象 0 件になっても成功してしまう事故を防ぐ。
    expect(targets.length, '検査対象が 0 件です（列挙の配線を確認してください）').toBeGreaterThan(0)

    const violations = collectViolations(targets)
    expect(violations, formatViolationReport(violations)).toEqual([])
  })
})

describe('有効化設定の検出パターン（誤検出・検出漏れの回帰防止）', () => {
  const cases: Array<[string, boolean]> = [
    // 検出する（保存を有効化する値・式）
    [`await browser.newContext({ trace: 'on' })`, true],
    [`await browser.newContext({ trace: 'retain-on-failure' })`, true],
    [`await browser.newContext({ trace: 'retry-with-trace' })`, true],
    [`await browser.newContext({ video: 'on' })`, true],
    [`await browser.newContext({ video: 'on-first-retry' })`, true],
    [`await browser.newContext({ screenshot: 'on' })`, true],
    [`await browser.newContext({ screenshot: 'only-on-failure' })`, true],
    [`await browser.newContext({ recordHar: { path: 'har/session.har' } })`, true],
    [`await browser.newContext({ recordVideo: { dir: 'videos' } })`, true],
    [`const options = { trace: traceEnabled }`, true], // 変数（値が確認できないため有効化として扱う）
    ['const options = { video: `on` }', true], // テンプレートリテラル
    ['const options = { recordHar: harOptions }', true],
    ['const options = { screenshot:true }', true], // 空白なし
    // 検出しない（明示的な無効化・コメント・文字列・無関係な識別子）
    [`await browser.newContext({ trace: 'off' })`, false],
    [`await browser.newContext({ video: 'off' })`, false],
    [`await browser.newContext({ screenshot: 'off' })`, false],
    [`// trace: 'on' は有効化しない（方針のメモ）`, false],
    [`// recordHar: は使わない（方針のメモ）`, false],
    [`/* trace: 'on' は有効化しない（方針のメモ） */`, false],
    [`const note = "trace: 'on' は使わない"`, false], // 文字列リテラルの中身
    ['const note = `recordHar: は使わない`', false], // テンプレートリテラルの中身
    ['const options = { traceable: true, videoCount: 0 }', false], // 識別子の部分一致
    ['const trace = createTrace()', false], // オプション指定ではない
    [`const options = {} // trace: 'on' にはしない`, false], // 行末コメント
  ]

  it.each(cases)('%s → %s', (line, expected) => {
    expect(isEnablingLine(line)).toBe(expected)
  })

  it('複数行のブロックコメント内の言及は検出しない', () => {
    const lines = ['/**', ` * trace: 'on' は有効化しない（方針のメモ）`, ' */', 'const value = 1']

    expect(collectViolationsFromLines(lines)).toEqual([])
  })

  it('複数行のテンプレートリテラル内の言及は検出しない', () => {
    const lines = [
      'const usage = `',
      `trace: 'on' は有効化しない（方針のメモ）`,
      '`',
      `const options = { video: 'on' }`,
    ]

    expect(collectViolationsFromLines(lines)).toEqual([4])
  })
})

/** 行配列を走査し、違反した行番号（1 始まり）を返す（行をまたぐ状態の検証用）。 */
const collectViolationsFromLines = (lines: readonly string[]): number[] => {
  const violations: number[] = []
  let inBlockComment = false
  let inTemplate = false

  lines.forEach((line, index) => {
    const result = scanLine(line, inBlockComment, inTemplate)
    inBlockComment = result.inBlockComment
    inTemplate = result.inTemplate
    if (result.enablingOptionCount > 0) violations.push(index + 1)
  })

  return violations
}
