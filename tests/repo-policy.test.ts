import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

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
 * 1 つ目は `uses` キーに続く保存 Action の参照（大文字小文字は問わない）を検出する。
 * 2 つ目は `uses` キーの値が同一行のプレーンスカラーでない記法（`>-` / `|` / コメントのみ /
 * 値なし、`!` `&` `*` で始まるタグ・アンカー・エイリアス）を検出する。値や参照が同一行に
 * なくても、デコレーションを挟んでも YAML としては解決され得るため、これを許すと行単位の
 * 検査をすり抜けて保存 Action を参照できてしまう。`uses` キーの直後にこれらで始まる正当な
 * Action 参照は存在しない。
 * 3 つ目は YAML の explicit key（`? uses`）を検出する。値は次行になるため行単位では解決
 * できないが、キーの行の時点で検出側に倒す。キーを引用符で囲む形（`"uses":` / `'uses':`）は
 * 1・2 つ目のパターンが引用符を許容することで検出する。
 *
 * 検査は行単位の best-effort。別行で定義したアンカーを参照する間接参照、引用符内の
 * エスケープやインラインデコレーション（`\x61` 等）による難読化、`run:` ステップ内での
 * 送出、別名・ラッパーなど未知の Action は防げない。レビューで補う。行単位の文字列一致
 * では YAML の等価表現を網羅できないため、YAML としてパースして `uses` キーを構造的に
 * 検査する方式は、この限界を閉じる将来の改善候補（依存追加が必要）。
 */
const forbiddenWorkflowPatterns: readonly RegExp[] = [
  /uses["']?\s*:\s*\S*upload-artifact/i,
  /uses["']?\s*:\s*(?:[>|#&*!]|$)/,
  /^\s*(?:-\s*)?\?\s*["']?uses["']?\s*$/,
]

interface Violation {
  readonly path: string
  readonly line: number
}

/**
 * 検査対象のファイルを git から列挙する。--exclude-standard により .gitignore 済みの
 * ファイル（.claude/plans/・.playwright-mcp/ 等のローカル専用ファイル）は含まれない。
 * 追跡済みと未追跡（ignore されていない新規ファイル）の両方を対象にする。
 */
const listRepoFiles = (): string[] =>
  execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((path) => path.length > 0)

/** 走査対象のファイル（リポジトリルートからの相対パス）を集める。 */
const collectTargetFiles = (): string[] =>
  listRepoFiles().filter((relativePath) => {
    const absolutePath = join(repoRoot, relativePath)

    if (absolutePath === selfPath) {
      return false
    }
    if (excludedDirectoryPrefixes.some((prefix) => relativePath.startsWith(prefix))) {
      return false
    }
    if (excludedFilePaths.has(relativePath)) {
      return false
    }

    const baseName = relativePath.slice(relativePath.lastIndexOf('/') + 1)
    if (
      !targetExtensions.has(extname(baseName).toLowerCase()) &&
      !extensionlessConfigFiles.has(baseName)
    ) {
      return false
    }

    // 未ステージで削除されたファイル（git の index に残っている）で落ちないよう存在を確認する。
    if (!existsSync(absolutePath)) {
      return false
    }

    // シンボリックリンク（AGENTS.md 等）は実体を二重に検査しないため対象外にする。
    return !lstatSync(absolutePath).isSymbolicLink()
  })

/** 行分割の改行パターン（CRLF / LF の両方を扱う。行番号を報告に使うため、ここで分割する）。 */
const LINE_BREAK_PATTERN = /\r?\n/

/** 行が規約違反（番号参照）に一致するか。全角文字は NFKC 正規化してから判定する。 */
const isForbiddenLine = (line: string): boolean => {
  const normalized = line.normalize('NFKC')
  return forbiddenPatterns.some((pattern) => pattern.test(normalized))
}

/** ワークフローの行が禁止パターン（保存 Action の参照）に一致するか。 */
const isForbiddenWorkflowLine = (line: string): boolean => {
  const normalized = line.normalize('NFKC')
  return forbiddenWorkflowPatterns.some((pattern) => pattern.test(normalized))
}

/** 対象ファイルを走査し、違反した行を集める。 */
const collectViolations = (filePaths: readonly string[]): Violation[] => {
  const violations: Violation[] = []

  for (const relativePath of filePaths) {
    const lines = readFileSync(join(repoRoot, relativePath), 'utf8').split(LINE_BREAK_PATTERN)

    lines.forEach((line, index) => {
      if (isForbiddenLine(line)) {
        violations.push({ path: relativePath, line: index + 1 })
      }
    })
  }

  return violations
}

/** `.github/` 配下のファイルだけを走査し、違反した行を集める。 */
const collectWorkflowViolations = (filePaths: readonly string[]): Violation[] => {
  const violations: Violation[] = []

  for (const relativePath of filePaths) {
    if (!relativePath.startsWith(githubDirectoryPrefix)) {
      continue
    }

    const lines = readFileSync(join(repoRoot, relativePath), 'utf8').split(LINE_BREAK_PATTERN)

    lines.forEach((line, index) => {
      if (isForbiddenWorkflowLine(line)) {
        violations.push({ path: relativePath, line: index + 1 })
      }
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
    `コメント規約違反を ${violations.length} 件検出しました（CLAUDE.md の「## コメント規約」を参照）。`,
    '設計書のセクション番号や Issue / PR 番号は、改版・移設で陳腐化するためコメントに書かない。',
    '',
    ...violations.map((violation) => `${violation.path}:${violation.line}`),
  ].join('\n')

/**
 * Artifact 保存の抑止で検出した違反を `path:line` の形式で列挙する。
 * 行の内容は出力しない（保存物の情報がテスト・CI ログへ漏れ得るため。Minimal Logging 準拠）。
 */
const formatWorkflowViolationReport = (violations: readonly Violation[]): string =>
  [
    `Action 定義で保存 Action の参照を ${violations.length} 件検出しました（.github/）。`,
    '認証セッション・Screenshot・Trace・HAR・Video などの機微な Artifact は CI から保存しない。',
    '',
    ...violations.map((violation) => `${violation.path}:${violation.line}`),
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
    const actionDefinitionFiles = collectTargetFiles().filter((relativePath) =>
      relativePath.startsWith(githubDirectoryPrefix),
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

describe('保存 Action の禁止パターン（誤検出・検出漏れの回帰防止）', () => {
  const cases: [string, boolean][] = [
    // 検出する（バージョンや SHA 固定、大文字表記、前置きの有無、行の位置を問わない）
    ['uses: actions/upload-artifact@v7', true],
    ['      - uses: actions/upload-artifact@v7', true],
    ['uses: actions/upload-artifact', true],
    // SHA 固定形式でも repo 名で検出できる（バージョンコメントの有無を問わない）
    ['uses: actions/upload-artifact@7d29b5b9e8b3f46f4f7e8b8e6b9c0b1c2d3e4f50 # v4.6.2', true],
    ['uses: Actions/Upload-Artifact@v7', true], // 大文字表記（大文字小文字は問わない）
    // 検出する（値が同一行のプレーンスカラーでない記法は 1 行目の時点で止め、迂回させない）
    ['      - uses: >-', true], // folded スカラー。値は次行以降だが、この行だけで検出する
    ['      - uses: |', true], // literal スカラー
    ['      - uses:', true], // 値が同一行にない
    ['      - uses: # 値は次行に書く', true], // コメントのみで値が同一行にない
    ['      - uses: !!str |', true], // タグ（!!str）付きの literal スカラー
    ['      - uses: &x >-', true], // アンカー（&x）付きの folded スカラー
    ['      - uses: *ref', true], // エイリアス（別行で定義したアンカーを参照する記法）
    // 検出する（キーの等価な書き方〈引用キー・explicit key〉も行の時点で止める）
    ['      - "uses": actions/upload-artifact@v4', true], // 二重引用符のキー
    ["      - 'uses': >-", true], // 単一引用符のキー + folded スカラー
    ['      - ? uses', true], // explicit key（値は次行。キーの行で検出する）
    ['        actions/upload-artifact@v4', false], // 値の行だけでは検出しない（上の行で止める）
    // 検出しない（保存以外の Action の参照、保存 Action を指さないコメント・run: 内の文字列）
    ['# upload-artifact による保存は行わない（方針のメモ）', false],
    ['run: echo "upload-artifact は使わない"', false],
    ['run: echo "uses: actions/checkout@v7"', false], // run: 内の文字列は複数行記法ではない
    ['uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', false],
    // 行末のバージョンコメント（値の後に `#` が来る形）は記法ではない
    ['uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1', false],
    // 引用キーでも保存 Action 以外は対象外（キー記法の一般化による誤検出がないこと）
    ['      - "uses": actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', false],
    ['uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020', false],
    ['uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413', false],
    ['uses: actions/download-artifact@v7', false],
    ['run: pnpm test', false],
  ]

  it.each(cases)('%s → %s', (line, expected) => {
    expect(isForbiddenWorkflowLine(line)).toBe(expected)
  })
})
