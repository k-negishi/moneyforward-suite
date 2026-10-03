import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * 依存境界（ヘキサゴナルアーキテクチャ）の検査。apps/<name>/src と packages/<name>/src の
 * import を許可行列と照合し、違反を file:line と import 指定子で報告する。
 * 依存の向きは Application Core へ向ける（Core は Framework / Runtime 非依存）。
 */
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/**
 * 検査対象。apps/<name>/src と packages/<name>/src の TypeScript（.ts / .tsx / .mts / .cts）を
 * 対象にし、ビルド生成物（dist）とテスト（各 package の test/）は依存の検査対象にしない。
 * 宣言ファイル（.d.ts / .d.mts / .d.cts）も末尾が ts 系のため対象に含まれるが、src 配下の
 * 宣言ファイルは型レベルの依存を持つため対象のままでよい（tsc の生成物は gitignore 済みの
 * dist に出力され、このパターンには一致しない）。
 */
const targetFilePattern = /^(?:apps|packages)\/[^/]+\/src\/.*\.(?:[cm]?ts|tsx)$/

/** 依存を許可する単位（unit）。unit はリポジトリルートからの先頭 2 セグメントで、workspace package と対応する。 */
interface UnitRule {
  readonly unit: string
  readonly packageName: string
  /** import を許可する workspace package（自 package は含めない）。 */
  readonly allowedWorkspacePackages: readonly string[]
  /** import を許可する npm パッケージ。指定名自身と subpath（`name/...`）を許可する。 */
  readonly allowedExternalPackages: readonly string[]
}

/**
 * パッケージ別の許可行列。ここに無い依存は許可しない。
 * - Core: Framework / Runtime 非依存（Node 組み込みと相対 import のみ）
 * - Security: Core へ依存してよい（逆方向は禁止）
 * - Adapter: Core・Security と、閉じ込めた技術（Playwright・AWS SDK）へ依存してよい
 * - Application: Core・Security・Adapter へ依存してよい（外部 SDK は Adapter に閉じる）
 * unit を追加したら、この表への登録が必要になる（未登録の unit はテスト失敗）。
 */
const unitRules: readonly UnitRule[] = [
  {
    unit: 'packages/core',
    packageName: '@mf-suite/core',
    allowedWorkspacePackages: [],
    allowedExternalPackages: [],
  },
  {
    unit: 'packages/security',
    packageName: '@mf-suite/security',
    allowedWorkspacePackages: ['@mf-suite/core'],
    allowedExternalPackages: [],
  },
  {
    unit: 'packages/adapter-moneyforward-playwright',
    packageName: '@mf-suite/adapter-moneyforward-playwright',
    allowedWorkspacePackages: ['@mf-suite/core', '@mf-suite/security'],
    allowedExternalPackages: ['playwright'],
  },
  {
    unit: 'packages/adapter-aws',
    packageName: '@mf-suite/adapter-aws',
    allowedWorkspacePackages: ['@mf-suite/core'],
    allowedExternalPackages: ['@aws-sdk'],
  },
  {
    unit: 'apps/automation',
    packageName: '@mf-suite/automation',
    allowedWorkspacePackages: [
      '@mf-suite/core',
      '@mf-suite/security',
      '@mf-suite/adapter-moneyforward-playwright',
      '@mf-suite/adapter-aws',
    ],
    allowedExternalPackages: [],
  },
]

interface Violation {
  readonly path: string
  readonly line: number
  readonly specifier: string
  readonly reason: string
}

interface SpecifierReference {
  readonly specifier: string
  readonly line: number
}

/**
 * 直近の字句を保持する数。`require` の直前が `.`（メソッド呼び出し）かを判別するために 3 つ見る。
 */
const tokenWindowSize = 3

/** 直後に正規表現リテラルを置けるキーワード（識別子の直後の `/` は除算のため、区別に使う）。 */
const regexPrefixKeywords = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'delete',
  'void',
  'instanceof',
  'new',
  'do',
  'else',
  'yield',
  'await',
  'throw',
])

/**
 * 直近の字句から、いま読んだ文字列が import 指定子かを判定する。
 * `from '...'`（import / export ... from）・`import '...'`（副作用 import）・
 * `import('...')` / `require('...')` の 3 形態を対象にする。
 */
const isImportSpecifierContext = (recentTokens: readonly string[]): boolean => {
  const last = recentTokens.at(-1)
  const beforeLast = recentTokens.at(-2)
  const beforeBeforeLast = recentTokens.at(-3)

  if (last === 'from' || last === 'import') return true

  // `x.require('...')` のようなメソッド呼び出しは対象外（`.` を挟む場合は import 指定子ではない）。
  return last === '(' && (beforeLast === 'import' || beforeLast === 'require') && beforeBeforeLast !== '.'
}

/** 直近の字句から、`/` が正規表現リテラルの開始かを判定する（識別子・数値等の直後は除算）。 */
const isRegexLiteralStart = (recentTokens: readonly string[]): boolean => {
  const last = recentTokens.at(-1)

  if (last === undefined) return true
  if (regexPrefixKeywords.has(last)) return true
  if (last === ')' || last === ']' || last === 'string' || last === 'template' || last === 'regex') {
    return false
  }
  return !/^[\w$]+$/.test(last)
}

/**
 * import 指定子を字句走査で抽出する。正規表現で一括抽出すると、コメント・文字列リテラル・
 * 正規表現リテラルの中の import 風の記述を依存として誤検出し、CI を不当に止める。
 * 走査は次の制限を持つ（誤検出を避ける側に倒し、検出漏れはレビューで補う）。
 * - 変数に組み立てた指定子（`require(name)` 等）は検出できない
 * - 補間（`${}`）を含むテンプレートリテラルの指定子は検出しない（補間の無いテンプレートは
 *   静的に決まるため、文字列リテラルと同じく指定子として読み取る）
 */
const extractSpecifierReferences = (source: string): SpecifierReference[] => {
  const references: SpecifierReference[] = []
  const recentTokens: string[] = []
  let line = 1
  let index = 0

  const pushToken = (token: string): void => {
    recentTokens.push(token)
    if (recentTokens.length > tokenWindowSize) recentTokens.shift()
  }

  /** 文字列リテラルを読み、import 指定子の文脈にあれば記録する。 */
  const readQuoted = (quote: string): void => {
    const startLine = line
    index += 1

    let value = ''
    while (index < source.length) {
      const char = source[index]
      if (char === '\\') {
        const escaped = source[index + 1] ?? ''
        // エスケープが行継続（\ + 改行）のときは行番号を進める。
        if (escaped === '\n') line += 1
        value += escaped
        index += 2
        continue
      }
      if (char === quote) {
        index += 1
        break
      }
      // 文字列は行を跨がない。未終端（走査の乱れ）は行末で打ち切って暴走を防ぐ。
      if (char === '\n') break
      value += char
      index += 1
    }

    if (isImportSpecifierContext(recentTokens)) {
      references.push({ specifier: value, line: startLine })
    }
    pushToken('string')
  }

  /** 文字列リテラルを読み飛ばす（テンプレートの `${}` の中など、指定子を拾わない文脈用）。 */
  const skipQuoted = (quote: string): void => {
    index += 1
    while (index < source.length) {
      const char = source[index]
      if (char === '\\') {
        if (source[index + 1] === '\n') line += 1
        index += 2
        continue
      }
      if (char === quote || char === '\n') {
        if (char === '\n') line += 1
        index += 1
        return
      }
      index += 1
    }
  }

  /** 正規表現リテラルを読み飛ばす（文字クラス内の `/` は終端にしない）。 */
  const skipRegexLiteral = (): void => {
    index += 1

    let inCharacterClass = false
    while (index < source.length) {
      const char = source[index]
      if (char === '\\') {
        if (source[index + 1] === '\n') line += 1
        index += 2
        continue
      }
      if (char === '\n') {
        // 正規表現は行を跨がない。乱れは行末で打ち切る（改行は呼び出し元の走査が数える）。
        return
      }
      if (char === '[') inCharacterClass = true
      else if (char === ']') inCharacterClass = false
      else if (char === '/' && !inCharacterClass) {
        index += 1
        break
      }
      index += 1
    }

    // フラグ（gimsuy 等）を読み飛ばす。
    while (index < source.length && /[a-z]/i.test(source[index])) index += 1
  }

  /**
   * テンプレートリテラルを読み、補間（`${}`）が無ければ文字列リテラルと同じく指定子として扱う。
   * 補間を含む場合は値を静的に決められないため、記録せずに読み飛ばす。
   */
  const readTemplate = (): void => {
    const startLine = line
    index += 1

    let value = ''
    let hasInterpolation = false
    while (index < source.length) {
      const char = source[index]
      if (char === '\\') {
        const escaped = source[index + 1] ?? ''
        // エスケープが行継続（\ + 改行）のときは行番号を進める。
        if (escaped === '\n') line += 1
        value += escaped
        index += 2
        continue
      }
      if (char === '`') {
        index += 1
        break
      }
      if (char === '\n') {
        line += 1
        value += char
        index += 1
        continue
      }
      if (char === '$' && source[index + 1] === '{') {
        hasInterpolation = true
        index += 2
        skipInterpolation()
        continue
      }
      value += char
      index += 1
    }

    if (!hasInterpolation && isImportSpecifierContext(recentTokens)) {
      references.push({ specifier: value, line: startLine })
    }
    pushToken(hasInterpolation ? 'template' : 'string')
  }

  /** テンプレートリテラルを読み飛ばす。`${}` の中は再帰的に読み飛ばす。 */
  function skipTemplate(): void {
    index += 1
    while (index < source.length) {
      const char = source[index]
      if (char === '\\') {
        if (source[index + 1] === '\n') line += 1
        index += 2
        continue
      }
      if (char === '\n') {
        line += 1
        index += 1
        continue
      }
      if (char === '`') {
        index += 1
        return
      }
      if (char === '$' && source[index + 1] === '{') {
        index += 2
        skipInterpolation()
        continue
      }
      index += 1
    }
  }

  /** テンプレートの `${}` の中（コード）を、対応する `}` まで読み飛ばす。 */
  function skipInterpolation(): void {
    let depth = 1
    while (index < source.length && depth > 0) {
      const char = source[index]
      if (char === '\n') {
        line += 1
        index += 1
        continue
      }
      if (char === "'" || char === '"') {
        skipQuoted(char)
        continue
      }
      if (char === '`') {
        skipTemplate()
        continue
      }
      if (char === '{') depth += 1
      else if (char === '}') depth -= 1
      index += 1
    }
  }

  while (index < source.length) {
    const char = source[index]

    if (char === '\n') {
      line += 1
      index += 1
      continue
    }
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') line += 1
        index += 1
      }
      index = Math.min(index + 2, source.length)
      continue
    }
    if (char === "'" || char === '"') {
      readQuoted(char)
      continue
    }
    if (char === '`') {
      readTemplate()
      continue
    }
    if (char === '/' && isRegexLiteralStart(recentTokens)) {
      skipRegexLiteral()
      pushToken('regex')
      continue
    }
    if (/[\w$]/.test(char)) {
      let word = ''
      while (index < source.length && /[\w$]/.test(source[index])) {
        word += source[index]
        index += 1
      }
      pushToken(word)
      continue
    }

    pushToken(char)
    index += 1
  }

  return references
}

/** filePath から unit（リポジトリルートからの先頭 2 セグメント）を求める。 */
const unitOfPath = (filePath: string): string => filePath.split('/').slice(0, 2).join('/')

const ruleByUnit = new Map(unitRules.map((rule) => [rule.unit, rule]))

/**
 * specifier が指す workspace package を返す。subpath（`@mf-suite/core/...`）も
 * 同じ package として扱う（名前の前方一致は `/` の境界で判定し、別名の誤判定を防ぐ）。
 */
const findWorkspacePackage = (
  specifier: string,
): { readonly packageName: string; readonly unit: string } | null => {
  for (const candidate of unitRules) {
    if (specifier === candidate.packageName || specifier.startsWith(`${candidate.packageName}/`)) {
      return { packageName: candidate.packageName, unit: candidate.unit }
    }
  }
  return null
}

const isRelativeSpecifier = (specifier: string): boolean =>
  specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../')

/**
 * bare import の指定子に `.` / `..` のパスセグメントを含むか。
 * `playwright/../@aws-sdk/...` のような指定子は解決後に別パッケージを指すため、
 * 許可行列の前方一致判定に通さず違反として報告する。
 */
const hasDotSegment = (specifier: string): boolean =>
  specifier.split('/').some((segment) => segment === '.' || segment === '..')

/** 相対 import が unit（パッケージ）の外へ出るかを判定する。 */
const escapesUnit = (filePath: string, specifier: string): boolean => {
  const unit = unitOfPath(filePath)
  const resolved = posix.normalize(posix.join(posix.dirname(filePath), specifier))
  return resolved !== unit && !resolved.startsWith(`${unit}/`)
}

/** 外部パッケージの import が許可行列にあるか（subpath を含む）。 */
const isAllowedExternalPackage = (rule: UnitRule | undefined, specifier: string): boolean =>
  rule !== undefined &&
  rule.allowedExternalPackages.some(
    (packageName) => specifier === packageName || specifier.startsWith(`${packageName}/`),
  )

const disallowedExternalReason = (unit: string): string =>
  unit === 'packages/core'
    ? 'Core は Framework / Runtime 非依存のため、外部パッケージへ依存できない'
    : '許可行列に無い外部パッケージへの依存'

/**
 * 1 ファイル分の依存境界を検査する純関数。
 * filePath はリポジトリルートからの相対パスを前提にする。
 */
const checkSource = (filePath: string, source: string): Violation[] => {
  const unit = unitOfPath(filePath)
  const rule = ruleByUnit.get(unit)
  const violations: Violation[] = []

  for (const { specifier, line } of extractSpecifierReferences(source)) {
    if (isRelativeSpecifier(specifier)) {
      if (escapesUnit(filePath, specifier)) {
        violations.push({
          path: filePath,
          line,
          specifier,
          reason: '相対 import がパッケージ境界を越えている（workspace package 名で import する）',
        })
      }
      continue
    }

    if (hasDotSegment(specifier)) {
      violations.push({
        path: filePath,
        line,
        specifier,
        reason: '指定子に `.` / `..` セグメントを含む（解決後の別パッケージへの迂回を防ぐため許可しない）',
      })
      continue
    }

    if (isBuiltin(specifier)) continue

    const target = findWorkspacePackage(specifier)

    if (target !== null && target.unit === unit) {
      violations.push({
        path: filePath,
        line,
        specifier,
        reason: '自 package を bare import で参照している（相対 import を使う）',
      })
      continue
    }

    if (target !== null && target.unit.startsWith('apps/')) {
      violations.push({
        path: filePath,
        line,
        specifier,
        reason: unit.startsWith('apps/')
          ? 'アプリケーション間の import は禁止'
          : 'Application（apps/*）の package への依存は禁止',
      })
      continue
    }

    if (target !== null) {
      const allowed = rule !== undefined && rule.allowedWorkspacePackages.includes(target.packageName)
      if (!allowed) {
        violations.push({
          path: filePath,
          line,
          specifier,
          reason: '許可行列に無い workspace package への依存',
        })
      }
      continue
    }

    if (!isAllowedExternalPackage(rule, specifier)) {
      violations.push({
        path: filePath,
        line,
        specifier,
        reason: specifier.startsWith('@mf-suite/')
          ? '未登録の workspace package への依存（unitRules への追加が必要）'
          : disallowedExternalReason(unit),
      })
    }
  }

  return violations
}

/**
 * 検査対象のファイルを git から列挙する。--exclude-standard により .gitignore 済みの
 * ファイル（dist 等）は含まれない。追跡済みと未追跡（ignore されていない新規ファイル）の
 * 両方を対象にする。
 */
const listRepoFiles = (): string[] =>
  execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((path) => path.length > 0)

/** 検査対象のファイル（リポジトリルートからの相対パス）を集める。 */
const collectTargetFiles = (): string[] =>
  listRepoFiles().filter((relativePath) => {
    if (!targetFilePattern.test(relativePath)) return false

    const absolutePath = join(repoRoot, relativePath)

    // 未ステージで削除されたファイル（git の index に残っている）で落ちないよう存在を確認する。
    if (!existsSync(absolutePath)) return false

    // シンボリックリンクは実体を二重に検査しないため対象外にする。
    return !lstatSync(absolutePath).isSymbolicLink()
  })

/**
 * 違反を `path:line 指定子 — 理由` の形式で列挙した報告メッセージを組み立てる。
 * 行の内容そのものは出力しない（Minimal Logging に合わせ、import の特定に必要な最小限に留める）。
 */
const formatViolationReport = (violations: readonly Violation[]): string =>
  [
    `依存境界の違反を ${violations.length} 件検出しました。`,
    '依存の向きは Application Core へ向ける（Core は Framework / Runtime 非依存。逆向きの依存と、許可行列外の依存は禁止）。',
    '許可行列は tests/architecture.test.ts の unitRules を参照する。',
    '',
    ...violations.map(
      (violation) => `${violation.path}:${violation.line} ${violation.specifier} — ${violation.reason}`,
    ),
  ].join('\n')

/** 許可行列に未登録の unit を報告するメッセージを組み立てる。 */
const formatUnregisteredUnitReport = (units: readonly string[]): string =>
  [
    `許可行列に未登録の unit を ${units.length} 件検出しました。`,
    '境界（依存してよい相手）を決めてから tests/architecture.test.ts の unitRules に追加する。',
    '',
    ...units,
  ].join('\n')

describe('依存境界（Architecture Test）', () => {
  it('apps/*/src と packages/*/src の import が許可行列に従っている', () => {
    const targets = collectTargetFiles()

    // 列挙の配線が壊れて対象 0 件になっても成功してしまう事故を防ぐ。
    expect(targets.length, '検査対象が 0 件です（列挙の配線を確認してください）').toBeGreaterThan(0)

    const unregisteredUnits = [...new Set(targets.map(unitOfPath))].filter(
      (unit) => !ruleByUnit.has(unit),
    )
    expect(unregisteredUnits, formatUnregisteredUnitReport(unregisteredUnits)).toEqual([])

    const violations = targets.flatMap((relativePath) =>
      checkSource(relativePath, readFileSync(join(repoRoot, relativePath), 'utf8')),
    )
    expect(violations, formatViolationReport(violations)).toEqual([])
  })
})

describe('依存規則の回帰テスト（合成ソース）', () => {
  const cases: Array<{
    readonly name: string
    readonly filePath: string
    readonly source: string
    readonly expected: readonly string[]
  }> = [
    {
      name: 'Core: Node 組み込みと相対 import は許可する',
      filePath: 'packages/core/src/ports/fixture.ts',
      source: "import { join } from 'node:path'\nimport type { Result } from './result.js'\n",
      expected: [],
    },
    {
      name: 'Core: node: 接頭辞の無い Node 組み込みも許可する',
      filePath: 'packages/core/src/fixture.ts',
      source: "import { readFile } from 'fs/promises'",
      expected: [],
    },
    {
      name: 'Core: コメント・文字列・正規表現の中の import 風の記述は検出しない',
      filePath: 'packages/core/src/fixture.ts',
      source: [
        "// import { chromium } from 'playwright'",
        "/* export * from 'playwright' */",
        'const note = "require(\'playwright\')"',
        "const pattern = /from ['\"]playwright['\"]/",
      ].join('\n'),
      expected: [],
    },
    {
      name: 'Core: テンプレートリテラルの中の import 風の記述は文脈が無ければ検出しない',
      filePath: 'packages/core/src/fixture.ts',
      source: "const note = `import { chromium } from 'playwright'`",
      expected: [],
    },
    {
      name: 'Core: 補間の無いテンプレートリテラルの指定子は検出する',
      filePath: 'packages/core/src/fixture.mts',
      source: 'const loaded = await import(`playwright`)\n',
      expected: ['playwright'],
    },
    {
      name: 'Core: 補間を含むテンプレートリテラルの指定子は検出しない（既知の限界）',
      filePath: 'packages/core/src/fixture.ts',
      source: 'const loaded = await import(`./generated/${name}.js`)',
      expected: [],
    },
    {
      name: 'Adapter(Playwright): 補間の無いテンプレートリテラルの playwright は許可する',
      filePath: 'packages/adapter-moneyforward-playwright/src/fixture.ts',
      source: 'const loaded = await import(`playwright`)',
      expected: [],
    },
    {
      name: 'Security: Core への依存と Node 組み込みは許可する',
      filePath: 'packages/security/src/fixture.ts',
      source:
        "import type { Result } from '@mf-suite/core'\nimport { createHash } from 'node:crypto'\n",
      expected: [],
    },
    {
      name: 'Security: Core の subpath import も同じ package として許可する',
      filePath: 'packages/security/src/fixture.ts',
      source: "import type { LoggerPort } from '@mf-suite/core/ports/logger-port.js'",
      expected: [],
    },
    {
      name: 'Adapter(Playwright): playwright・Core・Security は許可する',
      filePath: 'packages/adapter-moneyforward-playwright/src/fixture.ts',
      source:
        "import { chromium } from 'playwright'\nimport type { Result } from '@mf-suite/core'\nimport type { Session } from '@mf-suite/security'\n",
      expected: [],
    },
    {
      name: 'Adapter(AWS): @aws-sdk/* と Core は許可する',
      filePath: 'packages/adapter-aws/src/fixture.ts',
      source:
        "import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager'\nimport type { SecretStorePort } from '@mf-suite/core'\n",
      expected: [],
    },
    {
      name: 'Application: Core・Security・両 Adapter と相対 import は許可する',
      filePath: 'apps/automation/src/fixture.ts',
      source: [
        "import type { Result } from '@mf-suite/core'",
        "import type { LoggerPort } from '@mf-suite/security'",
        "import type { Adapter } from '@mf-suite/adapter-moneyforward-playwright'",
        "import type { SecretStore } from '@mf-suite/adapter-aws'",
        "import { createHandler } from './handler.js'",
      ].join('\n'),
      expected: [],
    },
    {
      name: '複数行の from と副作用 import も抽出できる',
      filePath: 'packages/adapter-moneyforward-playwright/src/fixture.ts',
      source: "import {\n  chromium,\n} from 'playwright'\nimport './setup.js'\n",
      expected: [],
    },
    {
      name: 'Application（.tsx）: 外部 SDK の直接依存を検出する',
      filePath: 'apps/automation/src/component.tsx',
      source: "import { chromium } from 'playwright'",
      expected: ['playwright'],
    },
    {
      name: 'Core（.cts）: 禁止依存を検出する',
      filePath: 'packages/core/src/fixture.cts',
      source: "import { remote } from 'appium'",
      expected: ['appium'],
    },
    {
      name: 'Adapter(Playwright): `..` セグメントで AWS SDK へ迂回する指定子を検出する',
      filePath: 'packages/adapter-moneyforward-playwright/src/fixture.ts',
      source: "import { SecretsManagerClient } from 'playwright/../@aws-sdk/client-secrets-manager'",
      expected: ['playwright/../@aws-sdk/client-secrets-manager'],
    },
    {
      name: 'Adapter(AWS): `..` セグメントで playwright へ迂回する指定子を検出する',
      filePath: 'packages/adapter-aws/src/fixture.ts',
      source: "import { chromium } from '@aws-sdk/../playwright'",
      expected: ['@aws-sdk/../playwright'],
    },
    {
      name: 'Adapter(AWS): `.` セグメントを含む指定子も許可判定に通さない',
      filePath: 'packages/adapter-aws/src/fixture.ts',
      source: "import { SecretsManagerClient } from '@aws-sdk/./client-secrets-manager'",
      expected: ['@aws-sdk/./client-secrets-manager'],
    },
    {
      name: '相対 import の `..` は親ディレクトリ参照として扱う（越境しなければ許可）',
      filePath: 'packages/core/src/fixture.ts',
      source: "import { x } from '../ports/result.js'",
      expected: [],
    },
    {
      name: 'Core: playwright / aws-sdk / appium への依存を検出する',
      filePath: 'packages/core/src/fixture.ts',
      source: [
        "import { chromium } from 'playwright'",
        "import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager'",
        "import { remote } from 'appium'",
      ].join('\n'),
      expected: ['playwright', '@aws-sdk/client-secrets-manager', 'appium'],
    },
    {
      name: 'Core: Lambda 固有パッケージへの依存を検出する',
      filePath: 'packages/core/src/fixture.ts',
      source: "import type { Context } from 'aws-lambda'",
      expected: ['aws-lambda'],
    },
    {
      name: 'Core: Adapter への依存（逆向き）を検出する',
      filePath: 'packages/core/src/fixture.ts',
      source: "import type { Adapter } from '@mf-suite/adapter-moneyforward-playwright'",
      expected: ['@mf-suite/adapter-moneyforward-playwright'],
    },
    {
      name: 'Core: 自 package の bare import は検出する（相対 import を使う）',
      filePath: 'packages/core/src/fixture.ts',
      source: "import type { Result } from '@mf-suite/core'",
      expected: ['@mf-suite/core'],
    },
    {
      name: 'Core: 動的 import と require の禁止依存を検出する',
      filePath: 'packages/core/src/fixture.ts',
      source:
        "const loaded = await import('playwright')\nconst { chromium } = require('@aws-sdk/client-secrets-manager')\n",
      expected: ['playwright', '@aws-sdk/client-secrets-manager'],
    },
    {
      name: 'Core: 副作用 import と再 export の禁止依存を検出する',
      filePath: 'packages/core/src/fixture.ts',
      source: "import 'playwright'\nexport * from 'appium'\n",
      expected: ['playwright', 'appium'],
    },
    {
      name: 'Core: 文字列中の from ではなく import 文だけを検出する',
      filePath: 'packages/core/src/fixture.ts',
      source: "const text = \"from 'playwright'\"\nimport { join } from 'node:path'\n",
      expected: [],
    },
    {
      name: 'Security: playwright への依存を検出する',
      filePath: 'packages/security/src/fixture.ts',
      source: "import { chromium } from 'playwright'",
      expected: ['playwright'],
    },
    {
      name: 'Adapter(Playwright): AWS SDK への依存を検出する',
      filePath: 'packages/adapter-moneyforward-playwright/src/fixture.ts',
      source: "import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager'",
      expected: ['@aws-sdk/client-secrets-manager'],
    },
    {
      name: 'Adapter(AWS): playwright への依存を検出する',
      filePath: 'packages/adapter-aws/src/fixture.ts',
      source: "import { chromium } from 'playwright'",
      expected: ['playwright'],
    },
    {
      name: 'Adapter(Playwright): 名前が前方一致する別パッケージは許可しない',
      filePath: 'packages/adapter-moneyforward-playwright/src/fixture.ts',
      source: "import { chromium } from 'playwright-core'",
      expected: ['playwright-core'],
    },
    {
      name: 'Application: 外部 SDK の直接依存を検出する',
      filePath: 'apps/automation/src/fixture.ts',
      source:
        "import { chromium } from 'playwright'\nimport { SecretsManagerClient } from '@aws-sdk/client-secrets-manager'\n",
      expected: ['playwright', '@aws-sdk/client-secrets-manager'],
    },
    {
      name: 'Application: 他 Application の package への依存を検出する',
      filePath: 'apps/automation/src/fixture.ts',
      source: "import type { Worker } from '@mf-suite/paypay-worker'",
      expected: ['@mf-suite/paypay-worker'],
    },
    {
      name: 'Application: 登録済みの別 Application の package への依存を検出する',
      filePath: 'apps/paypay-worker/src/fixture.ts',
      source: "import type { Handler } from '@mf-suite/automation'",
      expected: ['@mf-suite/automation'],
    },
    {
      name: 'Core: Application の package への依存も検出する',
      filePath: 'packages/core/src/fixture.ts',
      source: "import type { Handler } from '@mf-suite/automation'",
      expected: ['@mf-suite/automation'],
    },
    {
      name: '相対 import のパッケージ越えを検出する（Core から別 package）',
      filePath: 'packages/core/src/fixture.ts',
      source: "import { x } from '../../security/src/index.js'",
      expected: ['../../security/src/index.js'],
    },
    {
      name: '相対 import のパッケージ越えを検出する（Adapter から Core）',
      filePath: 'packages/adapter-moneyforward-playwright/src/fixture.ts',
      source: "import { x } from '../../../packages/core/src/index.js'",
      expected: ['../../../packages/core/src/index.js'],
    },
    {
      name: '相対 import のパッケージ越えを検出する（Application から package）',
      filePath: 'apps/automation/src/fixture.ts',
      source: "import { x } from '../../../packages/core/src/index.js'",
      expected: ['../../../packages/core/src/index.js'],
    },
    {
      name: '許可行列に未登録の unit は workspace package への依存も拒否する',
      filePath: 'packages/new-package/src/fixture.ts',
      source: "import type { Result } from '@mf-suite/core'",
      expected: ['@mf-suite/core'],
    },
  ]

  it.each(cases)('$name', ({ filePath, source, expected }) => {
    expect(checkSource(filePath, source).map((violation) => violation.specifier)).toEqual([
      ...expected,
    ])
  })

  it('違反の行番号を import の位置で報告する', () => {
    const source = [
      "import { join } from 'node:path'",
      '',
      "import {",
      '  chromium,',
      "} from 'playwright'",
    ].join('\n')

    expect(checkSource('packages/core/src/fixture.ts', source)).toMatchObject([
      { line: 5, specifier: 'playwright' },
    ])
  })

  it('正規表現が行末で途切れても行番号がずれない', () => {
    const source = ['const re = /abc', "import { chromium } from 'playwright'"].join('\n')

    expect(checkSource('packages/core/src/fixture.ts', source)).toMatchObject([
      { line: 2, specifier: 'playwright' },
    ])
  })

  it('行継続（\\ + 改行）を含む文字列の後でも行番号がずれない', () => {
    const source = ["const text = 'a\\", "b'", "import { chromium } from 'playwright'"].join('\n')

    expect(checkSource('packages/core/src/fixture.ts', source)).toMatchObject([
      { line: 3, specifier: 'playwright' },
    ])
  })

  it('行継続（\\ + 改行）を含むテンプレートの後でも行番号がずれない', () => {
    const source = ['const t = `a\\', 'b`', "import { chromium } from 'playwright'"].join('\n')

    expect(checkSource('packages/core/src/fixture.ts', source)).toMatchObject([
      { line: 3, specifier: 'playwright' },
    ])
  })

  it('未登録の workspace package は unitRules への追加が必要と報告する', () => {
    const violations = checkSource(
      'apps/automation/src/fixture.ts',
      "import type { Worker } from '@mf-suite/paypay-worker'",
    )

    expect(violations).toMatchObject([
      {
        specifier: '@mf-suite/paypay-worker',
        reason: '未登録の workspace package への依存（unitRules への追加が必要）',
      },
    ])
  })

  it.each([
    ['apps/automation/src/handler.ts', true],
    ['apps/automation/src/component.tsx', true],
    ['apps/automation/src/nested/component.tsx', true],
    ['packages/core/src/index.mts', true],
    ['packages/core/src/index.cts', true],
    ['packages/core/src/ambient.d.ts', true],
    ['apps/automation/test/handler.ts', false],
    ['packages/core/dist/index.js', false],
    ['apps/automation/src/handler.js', false],
    ['tests/repo-policy.test.ts', false],
  ] as const)('検査対象の判定: %s → %s', (path, expected) => {
    expect(targetFilePattern.test(path)).toBe(expected)
  })
})
