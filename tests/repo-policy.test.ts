import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { extname, join, matchesGlob } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseAllDocuments } from 'yaml'

/**
 * リポジトリのルート。cwd に依存せず、このテストファイルの位置（tests/）から解決する。
 */
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/**
 * このテストファイル自身の絶対パス。禁止パターンのリテラルを含むため、走査対象から除く。
 * パスをハードコードせず自身の位置から解決する（テストを移動・改名しても除外が外れない）。
 */
const selfPath = fileURLToPath(import.meta.url)

/**
 * 検査対象の拡張子。コード・設定・Markdown（rules 含む）を対象にする。
 * 大文字拡張子（README.MD 等）も拾うため、判定は小文字化して行う。
 */
const targetExtensions = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.yaml',
  '.yml',
  '.json',
  '.jsonc',
  '.md',
])

/**
 * 拡張子を持たない設定ファイル。コメントを持ち得るため明示的に検査対象へ含める。
 */
const extensionlessConfigFiles = new Set(['.gitignore', '.npmrc'])

/**
 * 走査から除外するディレクトリ（リポジトリルートからの相対パスの先頭一致）。
 * docs/ は設計書・ADR・会話記録などのドキュメント類のため対象外（規約は番号参照を
 * コメントや README 等へ書かないことを定めるもので、ドキュメント類の本文は対象にしない）。
 */
const excludedDirectoryPrefixes = ['docs/', '.claude/skills/']

/**
 * 走査から除外するファイル（リポジトリルートからの相対パス）。pnpm-lock.yaml は自動生成物。
 */
const excludedFilePaths = new Set(['pnpm-lock.yaml'])

/**
 * Action 定義（ワークフロー・composite action）が置かれるディレクトリ（リポジトリルートからの相対パス）。
 * このディレクトリ配下のファイルだけを、保存 Action の参照の抑止で追加検査する。
 */
const githubDirectoryPrefix = '.github/'

/**
 * コメント規約（CLAUDE.md）で禁止する番号参照。番号は設計書の改版や Issue の移設で
 * 陳腐化するポインタになるため、コメントには書かない（由来はコミット・PR 本文に残す）。
 * 判定は NFKC 正規化後の行に対して行う（全角数字・全角＃の混入も検出するため）。
 */
const forbiddenPatterns: readonly RegExp[] = [
  /§\s*\d/, // セクション番号の参照（例: §27〜§34、設計書 §9）
  // § なしの参照（例: 設計書 9、設計書 9.1）。「設計書の2つ目」のような助数詞は対象外。
  /設計書\s*(?:の)?\s*\d{1,2}(?:\.\d{1,2})?(?!\d)(?!\s*[つ個])/,
  /第\s*\d{1,3}\s*[章節]/, // 章・節の参照（例: 第9章）
  /「\d{1,2}\.\s[^」]*」/, // 番号付き見出しの引用（例: 「33. ログ」。小数・日付を避け 1〜2 桁に限定）
  // Issue 番号（例: Issue #3、issue 3）。「Issue 3 件」のような件数は対象外。
  /Issue\s*#?\s*\d{1,4}(?!\d)(?!\s*[件つ個])/i,
  /\bPR[_-]?\d{1,4}(?!\d)/i, // PR 番号（例: PR2、PR-2、PR_2）。「PR 2 件」のような件数は対象外
  /\bPR\s*#\s*\d+/i, // PR 番号（# 付きの参照。例: PR #14）
  // 裸の番号参照（例: #5・#7、（#2））。見出し（## 1）、手順コメントの連番（# 10.）、
  // hex カラー（#123456）、URL アンカー（#1-overview）、HTML エンティティ（&#39;）、
  // C#8 のような識別子は対象外になるよう、前後の文字と桁数（hex 回避のため 4 桁まで）を限定する。
  /(?<![\w#])#\d{1,4}(?![\dA-Za-z_;-])/,
]

/**
 * `.github/` 配下で参照しない保存 Action。Artifact を GitHub 側へ保存する Action は、
 * 認証セッション・Screenshot・Trace・HAR・Video などの機微な情報を CI の外へ持ち出し得る。
 * 保存が必要な調査はローカルで行い、成果物は git 管理外に置く。
 *
 * 検査は行単位の文字列一致ではなく、ファイルを YAML としてパースして `uses` キーを構造的に
 * 辿る。行単位では、同じ Action 参照を表す等価な記法（folded / literal スカラー、タグ・
 * アンカー・エイリアス、引用符付きのキー、explicit key、大文字表記、引用符内のエスケープ）を
 * 網羅できず、検査をすり抜けられるため。パースに失敗したファイルは違反として扱う
 * （fail closed。解釈できない YAML を「違反なし」と読み飛ばすと、検査が黙って弱まる）。
 *
 * 残る限界: `run:` ステップからのネットワーク送出（YAML の `uses` を介さない参照）と、
 * 保存 Action を呼ぶ別名・ラッパー Action（未知の Action）は検出できない。レビューで補う。
 */
const forbiddenActionName = 'upload-artifact'

/** Action 定義（ワークフロー・composite action）として検査する拡張子（`.github/` 配下）。 */
const actionDefinitionExtensions = new Set(['.yaml', '.yml'])

/** Action 定義ファイルのパスか（`.github/` 配下の YAML だけを YAML として検査する）。 */
const isActionDefinitionPath = (path: string): boolean =>
  path.startsWith(githubDirectoryPrefix) &&
  actionDefinitionExtensions.has(extname(path).toLowerCase())

interface Violation {
  readonly path: string
  /** 違反位置の行番号（1 始まり）。YAML のパースエラーで位置を取れない場合だけ省略する。 */
  readonly line?: number
}

/**
 * git からファイルのパス一覧を列挙する。--exclude-standard により .gitignore 済みの
 * ファイル（.claude/plans/・.playwright-mcp/ 等のローカル専用ファイル）は含まれない。
 * --cached は追跡済み、--others は未追跡（ignore されていない新規ファイル）を返す。
 */
const listGitFiles = (source: '--cached' | '--others'): string[] =>
  execFileSync('git', ['ls-files', '-z', source, '--exclude-standard'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((path) => path.length > 0)

/**
 * 検査対象のファイル。追跡状態は、列挙後にファイルが消えていた場合の扱い
 * （未追跡は読み飛ばし・追跡は失敗）を決める。
 */
interface TargetFile {
  /** リポジトリルートからの相対パス。 */
  readonly path: string
  /** git の未追跡ファイル（ignore されていない新規ファイル）か。 */
  readonly untracked: boolean
}

/**
 * 走査対象のファイル（リポジトリルートからの相対パスと追跡状態）を集める。
 * 追跡済みと未追跡（ignore されていない新規ファイル）の両方を対象にする。
 */
const collectTargetFiles = (): TargetFile[] => {
  const targets: TargetFile[] = [
    ...listGitFiles('--cached').map((path) => ({ path, untracked: false })),
    ...listGitFiles('--others').map((path) => ({ path, untracked: true })),
  ]

  return targets.filter((target) => {
    const absolutePath = join(repoRoot, target.path)

    if (absolutePath === selfPath) {
      return false
    }
    if (excludedDirectoryPrefixes.some((prefix) => target.path.startsWith(prefix))) {
      return false
    }
    if (excludedFilePaths.has(target.path)) {
      return false
    }

    const baseName = target.path.slice(target.path.lastIndexOf('/') + 1)
    if (
      !targetExtensions.has(extname(baseName).toLowerCase()) &&
      !extensionlessConfigFiles.has(baseName)
    ) {
      return false
    }

    // 存在確認と種別判定を 1 回の lstat にまとめる。existsSync による事前確認では、確認から
    // 読み取りまでの間にファイルが消える隙間（TOCTOU）が残る。未ステージで削除されたファイル
    // （git の index に残っている）や、列挙の直後に並列実行する他テストが一時ファイル（境界
    // テストの probe 等）を削除した場合は、ここで除外する。列挙時点で存在しないファイルは
    // 追跡状態を問わず対象外にする（読み取り時の扱いとは別）。
    try {
      // シンボリックリンク（AGENTS.md 等）は実体を二重に検査しないため対象外にする。
      return !lstatSync(absolutePath).isSymbolicLink()
    } catch (error) {
      if (isMissingFileError(error)) {
        return false
      }
      throw error
    }
  })
}

/**
 * 読み取り対象のファイルが既に消えている（ENOENT）エラーか。
 * git の列挙から読み取りまでの間に、並列実行する他テストが一時ファイル（境界テストの
 * probe 等）を削除すると起こり得る。
 */
const isMissingFileError = (error: unknown): boolean => {
  if (!(error instanceof Error) || !('code' in error)) {
    return false
  }
  return error.code === 'ENOENT'
}

/**
 * 検査対象のファイルを読み取る。列挙後に消えた未追跡ファイル（並列実行する他テストの
 * 一時ファイル等）だけは読み飛ばして undefined を返す。追跡ファイルが消えているのは
 * 列挙と実体の不整合で、読み飛ばすと検査が黙って弱まるためテストを失敗させる。
 * ENOENT 以外の読み取り失敗も、これまでどおりテストを失敗させる。
 */
const readTargetFile = (target: TargetFile): string | undefined => {
  try {
    return readFileSync(join(repoRoot, target.path), 'utf8')
  } catch (error) {
    if (target.untracked && isMissingFileError(error)) {
      return undefined
    }
    throw error
  }
}

/** 行分割の改行パターン（CRLF / LF の両方を扱う。行番号を報告に使うため、ここで分割する）。 */
const LINE_BREAK_PATTERN = /\r?\n/

/** 行が規約違反（番号参照）に一致するか。全角文字は NFKC 正規化してから判定する。 */
const isForbiddenLine = (line: string): boolean => {
  const normalized = line.normalize('NFKC')
  return forbiddenPatterns.some((pattern) => pattern.test(normalized))
}

/** YAML のパース結果として報告する違反位置（パスは呼び出し元が添える）。 */
type ViolationLocation = Pick<Violation, 'line'>

/**
 * Action 定義ファイル（YAML）の中身をパースし、保存 Action を参照する `uses` キーの位置を返す。
 *
 * - `uses` キーの名前は完全一致で判定する（GitHub Actions が解釈するキーは正確な `uses` だけ。
 *   `USES` や全角の `ｕｓｅｓ` は別のキーになる）。
 * - 値はエイリアスを解決したうえで、大文字小文字を問わず `upload-artifact` を含む場合に違反
 *   とする（Action 名の大文字小文字は参照の同一性を変えない）。
 * - パースに失敗したファイルは違反として扱う（fail closed）。位置が取れれば行番号を添える。
 */
const locateForbiddenActionUses = (contents: string): ViolationLocation[] => {
  // 行番号はファイル内の位置で数える（ファイル間で対応が混ざらないよう、ここで作る）。
  const lineCounter = new LineCounter()

  let documents: ReturnType<typeof parseAllDocuments>
  try {
    documents = parseAllDocuments(contents, { lineCounter })
  } catch {
    // 構文エラーは通常 document.errors に集まる（この catch は想定外の入力への保険）。
    // 解釈できない入力を「違反なし」と読み飛ばさない。
    return [{ line: undefined }]
  }

  /** アンカー名 → そのノード。エイリアス（`*name`）の解決に使う。 */
  const anchors = new Map<string, unknown>()

  /** ノードがアンカー（`&name`）を持つ場合に表へ登録する（エイリアスの解決先になる）。 */
  const registerAnchor = (node: unknown): void => {
    if ((isScalar(node) || isMap(node) || isSeq(node)) && typeof node.anchor === 'string') {
      anchors.set(node.anchor, node)
    }
  }

  /** エイリアスの連鎖を解決する。解決できない・循環する場合は null。 */
  const resolveAliases = (node: unknown): unknown => {
    const seen = new Set<unknown>()
    let current = node
    while (isAlias(current)) {
      if (seen.has(current)) {
        return null
      }
      seen.add(current)
      current = anchors.get(current.source) ?? null
    }
    return current
  }

  const violations: ViolationLocation[] = []

  const walk = (node: unknown): void => {
    registerAnchor(node)

    if (isMap(node)) {
      for (const pair of node.items) {
        if (isScalar(pair.key) && pair.key.value === 'uses') {
          const value = resolveAliases(pair.value)
          if (
            isScalar(value) &&
            typeof value.value === 'string' &&
            value.value.toLowerCase().includes(forbiddenActionName)
          ) {
            // 行番号はキーの位置（`uses` を書いた行）を指す。位置が取れない場合だけ省略する。
            const range = pair.key.range
            violations.push({ line: range ? lineCounter.linePos(range[0]).line : undefined })
          }
        }
        // キーと値の両方を辿る（`uses` が入れ子のマップ・シーケンスの中にあっても拾う）。
        walk(pair.value)
        walk(pair.key)
      }
      return
    }

    if (isSeq(node)) {
      for (const item of node.items) {
        walk(item)
      }
    }
  }

  for (const document of documents) {
    if (document.errors.length > 0) {
      // パースエラーの内容（行の抜粋を含む）は報告せず、位置だけを違反として扱う。
      violations.push({ line: document.errors[0]?.linePos?.[0]?.line })
      continue
    }

    walk(document.contents)
  }

  return violations
}

/** 対象ファイルを走査し、違反した行を集める。 */
const collectViolations = (targets: readonly TargetFile[]): Violation[] => {
  const violations: Violation[] = []

  for (const target of targets) {
    const contents = readTargetFile(target)
    if (contents === undefined) {
      continue
    }

    const lines = contents.split(LINE_BREAK_PATTERN)

    lines.forEach((line, index) => {
      if (isForbiddenLine(line)) {
        violations.push({ path: target.path, line: index + 1 })
      }
    })
  }

  return violations
}

/** Action 定義ファイル（`.github/` 配下の YAML）を走査し、保存 Action の参照を集める。 */
const collectWorkflowViolations = (targets: readonly TargetFile[]): Violation[] => {
  const violations: Violation[] = []

  for (const target of targets) {
    if (!isActionDefinitionPath(target.path)) {
      continue
    }

    const contents = readTargetFile(target)
    if (contents === undefined) {
      continue
    }

    for (const location of locateForbiddenActionUses(contents)) {
      violations.push({ path: target.path, line: location.line })
    }
  }

  return violations
}

/** 違反の位置を `path` または `path:line` の形式にする（行番号を取れない場合がある）。 */
const formatViolationLocation = (violation: Violation): string =>
  violation.line === undefined ? violation.path : `${violation.path}:${violation.line}`

/**
 * 違反を `path(:line)` の形式で列挙した報告メッセージを組み立てる。
 * 行の内容は出力しない（機微情報がテスト・CI ログへ漏れ得るため。Minimal Logging 準拠）。
 */
const formatViolationReport = (violations: readonly Violation[]): string =>
  [
    `コメント規約違反を ${violations.length} 件検出しました（CLAUDE.md の「## コメント規約」を参照）。`,
    '設計書のセクション番号や Issue / PR 番号は、改版・移設で陳腐化するためコメントに書かない。',
    '',
    ...violations.map((violation) => formatViolationLocation(violation)),
  ].join('\n')

/**
 * Artifact 保存の抑止で検出した違反を `path(:line)` の形式で列挙する。
 * 行の内容は出力しない（保存物の情報がテスト・CI ログへ漏れ得るため。Minimal Logging 準拠）。
 */
const formatWorkflowViolationReport = (violations: readonly Violation[]): string =>
  [
    `Action 定義（.github/ の YAML）で保存 Action の参照、または YAML として解釈できない記述を ${violations.length} 件検出しました。`,
    '認証セッション・Screenshot・Trace・HAR・Video などの機微な Artifact は CI から保存しない。',
    '',
    ...violations.map((violation) => formatViolationLocation(violation)),
  ].join('\n')

describe('コメント規約（CLAUDE.md）', () => {
  it('設計書・Issue・PR の番号参照がコード・設定・rules に残っていない', () => {
    const targets = collectTargetFiles()

    // 列挙の配線が壊れて対象 0 件になっても成功してしまう事故を防ぐ。
    expect(targets.length, '検査対象が 0 件です（列挙の配線を確認してください）').toBeGreaterThan(0)

    const violations = collectViolations(targets)
    expect(violations, formatViolationReport(violations)).toEqual([])
  })
})

describe('検査対象の読み取り（列挙後の消滅と I/O エラー）', () => {
  it('列挙後に消えた未追跡ファイル（並列実行する他テストの一時ファイル等）は読み飛ばす', () => {
    // git の列挙後・読み取り前に消えたファイルと同じ条件（読み取り時に存在しない）を作る。
    // 0 件ガード（collectTargetFiles 側）と追跡ファイルの検査は変わらない。
    expect(
      collectViolations([
        { path: 'packages/core/boundary-probe-vanished/sample.ts', untracked: true },
      ]),
    ).toEqual([])
  })

  it('列挙後に消えた追跡ファイルは例外にする（読み飛ばしで検査を弱めない）', () => {
    expect(() =>
      collectViolations([{ path: 'packages/core/vanished-tracked.ts', untracked: false }]),
    ).toThrow('ENOENT')
  })

  it('ENOENT 以外の読み取り失敗は例外にする（未追跡でも読み飛ばさない）', () => {
    // packages/core は実在するディレクトリ（読み取りは EISDIR で失敗する）。
    expect(() => collectViolations([{ path: 'packages/core', untracked: true }])).toThrow()
  })
})

describe('禁止パターン（誤検出・検出漏れの回帰防止）', () => {
  const cases: [string, boolean][] = [
    // 検出する
    ['§9 に従う', true],
    ['§27〜§34 の制約', true],
    ['設計書 9 の構成に従う', true],
    ['設計書 9.1 の構成に従う', true],
    ['設計書 33. ログの原則', true],
    ['第9章の原則に従う', true],
    ['「33. ログ」の原則', true],
    ['Issue #3 の対応', true],
    ['issue #7 の対応', true],
    ['Issue 3 の完了条件を満たす', true],
    ['PR2 で追加する', true],
    ['pr2 で追加する', true],
    ['PR-2 / PR_2 の対応', true],
    ['PR #14 の対応', true],
    ['（#2）', true],
    ['#5・#7', true],
    ['#2.', true],
    ['#2の対応', true],
    ['設計書 §１２', true], // 全角数字（NFKC 正規化で検出）
    ['＃12 の対応', true], // 全角＃（NFKC 正規化で検出）
    ['PR１２ の対応', true], // 全角数字（NFKC 正規化で検出）
    // 検出しない
    ['## 1 概要', false], // 見出し
    ['### 1 概要', false], // 見出し
    ['# 10. 手順', false], // 手順コメントの連番
    ['# 1. corepack を無効化する', false], // 手順コメントの連番
    ['色は #123456 を使う', false], // hex カラー
    ['https://example.com/x#1-overview', false], // URL アンカー
    ['（#1-overview）', false], // URL アンカー（記号の直後）
    ['#2abc という識別子', false],
    ['&#39; のような実体参照', false],
    ['C#8 の機能', false],
    ['「2.0 リリース」', false], // 小数
    ['「1.2 倍」', false], // 小数
    ['「2025.10 予定」', false], // 日付
    ['「3.14」', false], // 小数
    ['設計書 2026 年の話', false], // 4 桁の年
    ['設計書の2つ目の原則に従う', false], // 助数詞
    ['設計書の 4 つの層', false], // 助数詞
    ['Issue 3 件が残っている', false], // 件数
    ['PR 2 件をまとめてマージした', false], // 件数
    ['PR 2025 年の予定', false], // 年
  ]

  it.each(cases)('%s → %s', (line, expected) => {
    expect(isForbiddenLine(line)).toBe(expected)
  })
})

describe('Action 定義の保存物（.github）', () => {
  it('機微な Artifact を保存する Action がワークフローと composite action に現れない', () => {
    const actionDefinitionFiles = collectTargetFiles().filter((target) =>
      isActionDefinitionPath(target.path),
    )

    // 列挙の配線が壊れて対象 0 件になっても成功してしまう事故を防ぐ。
    expect(
      actionDefinitionFiles.length,
      '検査対象が 0 件です（列挙の配線を確認してください）',
    ).toBeGreaterThan(0)

    const violations = collectWorkflowViolations(actionDefinitionFiles)
    expect(violations, formatWorkflowViolationReport(violations)).toEqual([])
  })
})

describe('保存 Action の検査（YAML パース・誤検出と検出漏れの回帰防止）', () => {
  /** ワークフローの最小構成に検査対象の記法を差し込む（先頭の step 行だけ `- ` を補う）。 */
  const workflowWithStep = (stepLines: readonly string[]): string =>
    [
      'name: probe',
      'on: workflow_dispatch',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      ...stepLines.map((line, index) => (index === 0 ? `      - ${line}` : line)),
      '',
    ].join('\n')

  const detectedCases: [name: string, definition: string, expectedLines: number[]][] = [
    ['プレーンスカラー', workflowWithStep(['uses: actions/upload-artifact@v7']), [7]],
    ['バージョンなし', workflowWithStep(['uses: actions/upload-artifact']), [7]],
    [
      'SHA 固定 + バージョンコメント',
      workflowWithStep([
        'uses: actions/upload-artifact@7d29b5b9e8b3f46f4f7e8b8e6b9c0b1c2d3e4f50 # v4.6.2',
      ]),
      [7],
    ],
    ['値の大文字表記', workflowWithStep(['uses: Actions/Upload-Artifact@v7']), [7]],
    [
      'folded スカラー',
      workflowWithStep(['uses: >-', '          actions/upload-artifact@v4']),
      [7],
    ],
    [
      'literal スカラー',
      workflowWithStep(['uses: |-', '          actions/upload-artifact@v4']),
      [7],
    ],
    ['二重引用符のキー', workflowWithStep(['"uses": actions/upload-artifact@v4']), [7]],
    [
      '単一引用符のキー + folded スカラー',
      workflowWithStep(["'uses': >-", '          actions/upload-artifact@v4']),
      [7],
    ],
    ['explicit key', workflowWithStep(['? uses', '        : actions/upload-artifact@v4']), [7]],
    [
      'explicit key + 行末コメント',
      workflowWithStep(['? uses # メモ', '        : actions/upload-artifact@v4']),
      [7],
    ],
    [
      'explicit key + タグ',
      workflowWithStep(['? !!str uses', '        : actions/upload-artifact@v4']),
      [7],
    ],
    [
      'explicit key（キーの内容は次行）',
      workflowWithStep(['?', '          uses', '        : actions/upload-artifact@v4']),
      [8],
    ],
    [
      'キーの行末コメント + 値は次行',
      workflowWithStep(['uses: # 値は次行に書く', '          actions/upload-artifact@v4']),
      [7],
    ],
    ['値は次行', workflowWithStep(['uses:', '          actions/upload-artifact@v4']), [7]],
    [
      'タグ付き literal スカラー',
      workflowWithStep(['uses: !!str |-', '          actions/upload-artifact@v4']),
      [7],
    ],
    [
      'アンカー付き folded スカラー',
      workflowWithStep(['uses: &x >-', '          actions/upload-artifact@v4']),
      [7],
    ],
    ['引用符内のエスケープ', workflowWithStep(['uses: "acti\\x6Fns/upload-artifact@v4"']), [7]],
    [
      '別行のアンカーをエイリアスで参照する',
      [
        'name: probe',
        'on: workflow_dispatch',
        'env:',
        '  REF: &ref actions/upload-artifact@v4',
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: *ref',
        '',
      ].join('\n'),
      [9],
    ],
    [
      'パースできない YAML（キーの内容を次行に置く不正形）',
      workflowWithStep(['?', '        uses', '        : actions/upload-artifact@v4']),
      [8],
    ],
  ]

  it.each(detectedCases)('%s → 検出する', (name, definition, expectedLines) => {
    expect(
      locateForbiddenActionUses(definition).map((violation) => violation.line),
      `ケース「${name}」: 期待する検出行は ${expectedLines.join(', ')}`,
    ).toEqual(expectedLines)
  })

  const notDetectedCases: [name: string, definition: string][] = [
    [
      '保存 Action 以外（download-artifact）',
      workflowWithStep(['uses: actions/download-artifact@v7']),
    ],
    [
      '保存 Action 以外（checkout + バージョンコメント）',
      workflowWithStep([
        'uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
      ]),
    ],
    [
      '引用キーでも保存 Action 以外は対象外',
      workflowWithStep(['"uses": actions/setup-node@820762786026740c76f36085b0efc47a31fe5020']),
    ],
    [
      'エイリアスでも保存 Action 以外は対象外',
      [
        'name: probe',
        'on: workflow_dispatch',
        'env:',
        '  REF: &ref actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: *ref',
        '',
      ].join('\n'),
    ],
    ['別のキーの値（name）', workflowWithStep(['name: actions/upload-artifact@v4'])],
    [
      'キーでない位置の文字列（step が文字列）',
      workflowWithStep(['run: echo hi', '      - actions/upload-artifact@v4']),
    ],
    [
      'コメント内の言及',
      workflowWithStep(['# upload-artifact による保存は行わない（方針のメモ）', 'run: pnpm test']),
    ],
    ['run: 内の文字列', workflowWithStep(['run: echo "upload-artifact は使わない"'])],
    ['run: 内の uses 風文字列', workflowWithStep(['run: \'echo "uses: actions/checkout@v7"\''])],
    ['値が空の uses（null は参照ではない）', workflowWithStep(['uses:', '        run: echo hi'])],
    [
      'コメントのみの uses（null は参照ではない）',
      workflowWithStep(['uses: # コメントのみ', '        run: echo hi']),
    ],
    ['大文字キー（USES）は別のキー', workflowWithStep(['USES: actions/upload-artifact@v4'])],
    ['全角キー（ｕｓｅｓ）は別のキー', workflowWithStep(['ｕｓｅｓ: actions/upload-artifact@v4'])],
    ['uses キーを持たない YAML', 'jobs: {}\n'],
    ['空のファイル', ''],
  ]

  it.each(notDetectedCases)('%s → 検出しない', (name, definition) => {
    expect(locateForbiddenActionUses(definition), `ケース「${name}」で誤検出しました`).toEqual([])
  })

  it('行番号はファイル内の位置（1 始まり）を指す', () => {
    const definition = workflowWithStep([
      'uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      '      - uses: actions/upload-artifact@v7',
    ])

    expect(locateForbiddenActionUses(definition)).toEqual([{ line: 8 }])
  })
})

/**
 * JSONC からコメントだけを取り除く（文字列の内外を区別する最小の状態機械）。
 * biome.jsonc はコメント付き JSON（末尾カンマなし）で運用しているため、これで JSON.parse に
 * 渡せる。対応しない記法（末尾カンマ等）が入った場合は JSON.parse が失敗してテストが落ちる
 * （黙って検査を弱めない）。
 */
const stripJsonComments = (source: string): string => {
  const result: string[] = []
  let inString = false
  let inLineComment = false
  let inBlockComment = false

  for (let index = 0; index < source.length; index += 1) {
    const char = source.charAt(index)
    const next = source.charAt(index + 1)

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false
        result.push(char)
      }
      continue
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false
        index += 1
      }
      continue
    }
    if (inString) {
      result.push(char)
      if (char === '\\') {
        result.push(next)
        index += 1
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      result.push(char)
    } else if (char === '/' && next === '/') {
      inLineComment = true
      index += 1
    } else if (char === '/' && next === '*') {
      inBlockComment = true
      index += 1
    } else {
      result.push(char)
    }
  }

  return result.join('')
}

/** biome.jsonc の overrides（検査に必要な範囲）。 */
interface BiomeOverride {
  /** 適用対象の glob（Biome の includes）。否定（`!` 始まり）は「対象外」の指定なので検査しない。 */
  readonly includes?: readonly string[]
}

interface BiomeConfig {
  readonly overrides?: readonly BiomeOverride[]
}

describe('biome.jsonc の overrides の対象ファイル', () => {
  it('include パターンが実在するファイルに一致する（ファイル移動で無効化されていない）', () => {
    const config: BiomeConfig = JSON.parse(
      stripJsonComments(readFileSync(join(repoRoot, 'biome.jsonc'), 'utf8')),
    )
    const overrides = config.overrides ?? []

    // overrides が空・読み取りの崩れで「一致 0 件」の検査自体が無意味になる事故を防ぐ。
    expect(overrides.length, 'biome.jsonc の overrides を読み取れませんでした').toBeGreaterThan(0)

    // 追跡ファイルを基準にする（未追跡の一時ファイルが偶然一致する状態を「一致あり」と
    // 見なさない）。
    const files = listGitFiles('--cached')
    const unmatchedIncludes: string[] = []

    for (const override of overrides) {
      for (const include of override.includes ?? []) {
        if (include.startsWith('!')) {
          continue
        }
        if (!files.some((file) => matchesGlob(file, include))) {
          unmatchedIncludes.push(include)
        }
      }
    }

    expect(
      unmatchedIncludes,
      `一致するファイルが 1 件もない include: ${unmatchedIncludes.join(', ')}`,
    ).toEqual([])
  })
})
