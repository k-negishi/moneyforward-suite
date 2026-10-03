import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * Playwright Artifact（Screenshot / HTML / DOM Dump / HAR / Trace / Video）の非保存を、
 * ソースに有効化設定が存在しないことで検査する（ADR-0017）。
 * 実行時の抑止（launch / context の options builder とそのテスト）も必要で、
 * この静的な検査はその二重防御の 1 層。
 *
 * 検出するのはソース中の直接の記述（object option とその引用キー、tracing.start /
 * screenshot 呼び出し、tracesDir 指定）だけ。変数へ組み立てて渡す場合、プロパティ代入
 * （`options.trace = 'on'`）、ラッパー越しの設定、将来 `playwright.config.*` へ集約する形は
 * 検出対象外（等価な書き方を網羅できないため、出現した時点で走査対象とパターンの追加を
 * 検討し、それまではレビューで補う）。
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

/** 位置 start 以降の次の非空白文字を返す（行末なら空文字）。 */
const nextCodeChar = (line: string, start: number): string => line[skipSpaces(line, start)] ?? ''

/**
 * `tracing.start(`（プロパティアクセスと空白を許容）の並びかを判定する。
 * tracing の開始呼び出しは Trace 保存の有効化意図として扱う。
 */
const isTracingStartCall = (line: string, start: number): boolean => {
  const dot = skipSpaces(line, start)
  if (line[dot] !== '.') return false

  const nameStart = skipSpaces(line, dot + 1)
  if (!isIdentifierStart(line[nameStart] ?? '')) return false

  let end = nameStart + 1
  while (end < line.length && isIdentifierPart(line[end] as string)) end += 1
  if (line.slice(nameStart, end) !== 'start') return false

  return nextCodeChar(line, end) === '('
}

/**
 * オブジェクトリテラルのキー位置か（直前までに読んだコード文字が `{` か `,`）。
 * 三項演算子（`cond ? 'trace' : 'video'`）や case ラベル（`case 'trace':`）の
 * 文字列を引用キーと誤認しないための条件。
 */
const isObjectKeyPosition = (lastCodeChar: string): boolean =>
  lastCodeChar === '{' || lastCodeChar === ','

/** 行をまたいで持ち越す走査状態。 */
interface ScanCarryState {
  readonly inBlockComment: boolean
  readonly inTemplate: boolean
  /**
   * 直前までに読んだコード上の文字（空白とコメントは飛ばし、文字列・テンプレートは
   * 終端の引用符）。引用キー（`{ 'trace': ... }`）の位置判定に使う。
   */
  readonly lastCodeChar: string
}

const initialScanCarryState: ScanCarryState = {
  inBlockComment: false,
  inTemplate: false,
  lastCodeChar: '',
}

interface LineScanResult {
  readonly enablingOptionCount: number
  readonly state: ScanCarryState
}

/**
 * 1 行を走査し、Artifact 保存を有効化する指定の数を返す。
 * コメント（行・ブロック）と文字列リテラルの中身はコードとして解釈しない
 * （コメント内の言及を誤検出しない）。ブロックコメントと複数行テンプレートは行をまたぐため、
 * 状態を持ち越す。制限: テンプレートリテラルの補間の中身は文字列として扱う（検出しない）。
 */
const scanLine = (line: string, initial: ScanCarryState): LineScanResult => {
  let i = 0
  let count = 0
  let block = initial.inBlockComment
  let template = initial.inTemplate
  let lastCodeChar = initial.lastCodeChar

  const result = (): LineScanResult => ({
    enablingOptionCount: count,
    state: { inBlockComment: block, inTemplate: template, lastCodeChar },
  })

  while (i < line.length) {
    if (template) {
      const end = findTemplateEnd(line, i)
      if (end === -1) {
        template = true
        return result()
      }
      template = false
      lastCodeChar = '`'
      i = end
      continue
    }

    if (block) {
      const end = line.indexOf('*/', i)
      if (end === -1) {
        block = true
        return result()
      }
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
      if (end === -1) {
        template = true
        return result()
      }
      lastCodeChar = '`'
      i = end
      continue
    }
    if (ch === '"' || ch === "'") {
      const end = skipStringLiteral(line, i)
      const literal = readStringLiteral(line, i)
      // 引用キー（{ 'trace': 'on' } / { "trace": 'on' }）の検出。値の扱いは識別子キーと同じ
      // （'off' の明示があるときだけ無効とみなす）。
      if (literal !== null && isObjectKeyPosition(lastCodeChar) && optionNames.has(literal)) {
        const colon = skipSpaces(line, end)
        if (line[colon] === ':') {
          const valueStart = skipSpaces(line, colon + 1)
          const valueLiteral = readStringLiteral(line, valueStart)
          if (!(toggleOptionNames.has(literal) && valueLiteral === 'off')) count += 1
        }
      }
      lastCodeChar = ch
      i = end
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

      // options を経ない直接 API 形の検出（保存を有効化する呼び出し・設定）。
      if (name === 'tracing' && isTracingStartCall(line, end)) count += 1
      else if (name === 'screenshot' && lastCodeChar === '.' && nextCodeChar(line, end) === '(') {
        count += 1
      } else if (name === 'tracesDir') count += 1

      lastCodeChar = name
      i = end
      continue
    }

    // 空白は「直前のコード文字」ではないため、キー位置の判定用には記録しない。
    if (ch !== ' ' && ch !== '\t') lastCodeChar = ch
    i += 1
  }

  return result()
}

/** 行が有効化設定（コード部分）に一致するか。回帰防止の表から直接呼ぶ。 */
const isEnablingLine = (line: string): boolean =>
  scanLine(line, initialScanCarryState).enablingOptionCount > 0

interface Violation {
  readonly path: string
  readonly line: number
}

/** 対象ファイルを走査し、違反した行を集める（行をまたぐコメント状態を持ち越す）。 */
const collectViolations = (filePaths: readonly string[]): Violation[] => {
  const violations: Violation[] = []

  for (const relativePath of filePaths) {
    const lines = readFileSync(join(repoRoot, relativePath), 'utf8').split(/\r?\n/)
    let state = initialScanCarryState

    lines.forEach((line, index) => {
      const result = scanLine(line, state)
      state = result.state
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
    const targetsByDirectory = targetSourceDirectories().map((directory) => ({
      directory,
      files: collectSourceFiles(directory),
    }))

    // 各対象ディレクトリが存在し、ソースを 1 件以上持つことを確かめる。改名・移動で
    // 走査範囲が黙って狭まり、検査が素通りする事故を防ぐ（対象を移した場合は
    // targetSourceDirectories の列挙も更新する）。
    for (const { directory, files } of targetsByDirectory) {
      expect(
        existsSync(join(repoRoot, directory)),
        `検査対象ディレクトリが存在しません（改名・移動の場合は列挙を更新してください）: ${directory}`,
      ).toBe(true)
      expect(files.length, `検査対象のソースが 0 件です: ${directory}`).toBeGreaterThan(0)
    }

    const targets = targetsByDirectory.flatMap((entry) => entry.files)
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
    [`const options = { 'trace': 'on' }`, true], // 引用キー（単一引用符）
    [`const options = { "video": 'on' }`, true], // 引用キー（二重引用符）
    [`const options = { 'screenshot': 'only-on-failure' }`, true], // 引用キー + 保存系の値
    [`const options = { 'recordHar': { path: 'session.har' } }`, true],
    ['const options = { tracesDir: tracesPath }', true], // Trace の配置先指定
    ['await context.tracing.start({ screenshots: true, snapshots: true })', true], // 直接 API 形
    ['await page.screenshot({ path: shotPath })', true], // 直接 API 形
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
    [`const options = { 'trace': 'off' }`, false], // 引用キー + 明示的な無効化
    ['const kind = flag ? "trace" : "video"', false], // 三項演算子の文字列
    [`switch (key) { case 'trace': break }`, false], // case ラベル
    ['const key = "trace"', false], // 代入された文字列
    ['const screenshot = await capture()', false], // ローカル変数（プロパティ呼び出しでない）
    ['const tracing = createTracing()', false], // start 呼び出しでない
    ['const tracesDirectory = tracesPath', false], // 識別子の部分一致
    ["const note = 'tracesDir は使わない'", false], // 文字列リテラルの中身
    ['// context.tracing.start() はしない（方針のメモ）', false], // コメント内の言及
    ['// page.screenshot() はしない（方針のメモ）', false],
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

  it('複数行に分かれた引用キーと直接 API 形も検出する', () => {
    const lines = [
      'const options = {',
      `  'trace': 'on',`,
      '  video: `on`,',
      '}',
      'await context.tracing.start({ screenshots: true })',
      'await page.screenshot({ path: shotPath })',
      'const config = { tracesDir }',
    ]

    expect(collectViolationsFromLines(lines)).toEqual([2, 3, 5, 6, 7])
  })

  it('複数行に分かれた三項演算子の文字列は検出しない', () => {
    const lines = ['const kind =', '  flag', '    ? "trace"', '    : "video"']

    expect(collectViolationsFromLines(lines)).toEqual([])
  })
})

/** 行配列を走査し、違反した行番号（1 始まり）を返す（行をまたぐ状態の検証用）。 */
const collectViolationsFromLines = (lines: readonly string[]): number[] => {
  const violations: number[] = []
  let state = initialScanCarryState

  lines.forEach((line, index) => {
    const result = scanLine(line, state)
    state = result.state
    if (result.enablingOptionCount > 0) violations.push(index + 1)
  })

  return violations
}
