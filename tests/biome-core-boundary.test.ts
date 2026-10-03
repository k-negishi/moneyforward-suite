import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * noRestrictedImports（Core の依存境界ルール）の前提を固定するテスト。
 *
 * 背景: パッケージ名だけの指定では subpath 付きの import（`@aws-sdk/client-s3/commands/put-object`
 * など）が素通りするため、biome.jsonc ではパッケージ名に加えて `/*`（1 階層）と `/**`（入れ子）の
 * 形も列挙している。このテストは、その指定で代表的な Framework / Runtime 依存（bare・subpath・
 * scoped）が検出され、正常な import（Node 組み込み・相対）は検出されないことを固定する。
 * ルールは packages/core/** の override にだけ設定しているため、Adapter 側では同じ playwright が
 * 検出されないことも固定する（Core だけを縛る境界の回帰テスト）。
 *
 * プローブは packages/<name>/ 直下の一時ディレクトリに作る。packages/<name>/src の外に置くのは、
 * Architecture Test の走査対象（src 配下の import）へ一時ファイルを混ぜないため。
 */
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/** 実行時に使う biome バイナリ（リポジトリの devDependencies と同一）。 */
const biomeBinary = join(repoRoot, 'node_modules', '.bin', 'biome')

/** リポジトリの biome 設定（noRestrictedImports の override を含む）。 */
const configPath = join(repoRoot, 'biome.jsonc')

/** Core で検出されることを固定する代表例（bare・subpath・scoped を網羅する）。 */
const restrictedSpecifiers = [
  // ブラウザ自動化（bare と、入れ子 subpath の `/**` 形）
  'playwright',
  'playwright-core/lib/server',
  // AWS（scoped の入れ子 subpath。`@aws-sdk/*` だけでは 3 階層目が素通りする）
  '@aws-sdk/client-s3/commands/put-object',
  // scoped パッケージ（`@scope/*` 形）
  '@puppeteer/browsers',
  // Web Framework（`next` の subpath 形）
  'next/server',
  // Lambda ランタイム（`@middy/*` 形）
  '@middy/core',
  // モバイル自動化（bare 形）
  'appium',
] as const

/** execFileSync が非 0 終了で投げるエラー（status / stdout / stderr を持つ）。 */
interface ExecFailure {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

const isExecFailure = (error: unknown): error is ExecFailure => {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  if (!('status' in error) || !('stdout' in error) || !('stderr' in error)) {
    return false
  }
  return (
    typeof error.status === 'number' &&
    typeof error.stdout === 'string' &&
    typeof error.stderr === 'string'
  )
}

/**
 * unit（packages/<name>）直下に一時ファイルを 1 つ作って noRestrictedImports だけを実行し、
 * 終了コードと出力を返す。検出時は終了コードが非 0 になる（診断は error 固定）。
 * 一時ディレクトリは必ず削除する。
 */
const lintAsBoundaryProbe = (
  unit: string,
  contents: string,
): { readonly status: number; readonly output: string } => {
  const directory = mkdtempSync(join(repoRoot, unit, 'boundary-probe-'))
  try {
    const filePath = join(directory, 'sample.ts')
    writeFileSync(filePath, contents)
    const output = execFileSync(
      biomeBinary,
      ['lint', '--only=style/noRestrictedImports', `--config-path=${configPath}`, filePath],
      // stderr を親へ継承させない（診断の生出力をテストログへ流さない。捕捉は error 経由で行う）。
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    return { status: 0, output }
  } catch (error) {
    if (isExecFailure(error)) {
      return { status: error.status, output: `${error.stdout}${error.stderr}` }
    }
    throw error
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('noRestrictedImports（Core の境界ルール）の前提', () => {
  // biome の実行ファイルは Windows では biome.cmd になり、このテストは node_modules/.bin 直下の
  // 実行ファイルを前提にする。実行環境（CI は Linux）を単純に保つため、Windows では実行しない。
  const itUnlessWindows = it.skipIf(process.platform === 'win32')

  itUnlessWindows(
    '代表的な Framework / Runtime 依存（bare・subpath・scoped）を Core で検出する',
    () => {
      for (const specifier of restrictedSpecifiers) {
        const result = lintAsBoundaryProbe('packages/core', `import '${specifier}'\n`)

        expect(result.status, `${specifier} が検出されません`).not.toBe(0)
        expect(result.output).toContain('noRestrictedImports')
      }
    },
  )

  itUnlessWindows('Node 組み込みと相対 import は Core で検出しない', () => {
    const result = lintAsBoundaryProbe(
      'packages/core',
      "import { readFileSync } from 'node:fs'\nimport { isErrorCode } from '../errors.js'\n",
    )

    expect(result.status).toBe(0)
  })

  itUnlessWindows('Adapter では playwright を検出しない（ルールは Core にだけ適用する）', () => {
    const result = lintAsBoundaryProbe(
      'packages/adapter-moneyforward-playwright',
      "import { chromium } from 'playwright'\n",
    )

    expect(result.status).toBe(0)
  })
})
