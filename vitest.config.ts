import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

/**
 * workspace package（packages/*）のディレクトリ名。
 * Vitest の project 名と alias の両方をこの配列から生成し、追加漏れを防ぐ。
 */
const workspacePackageNames = [
  'core',
  'security',
  'adapter-moneyforward-playwright',
  'adapter-aws',
] as const

/**
 * `@mf-automation/*` を各 package のビルド済み dist ではなく src へ解決する。
 * package.json の exports は dist を指すため、ビルド前でもテストを実行できるようにする。
 */
const workspaceAlias: Record<string, string> = Object.fromEntries(
  workspacePackageNames.map((packageName) => [
    `@mf-automation/${packageName}`,
    fileURLToPath(new URL(`./packages/${packageName}/src/index.ts`, import.meta.url)),
  ]),
)

/**
 * project の root は cwd 相対で解決されるため、この設定ファイル基準の絶対パスにする。
 * これにより、ルートからの実行と各 package からの実行（`pnpm --filter <pkg> test`）の双方で動く。
 */
const projectRoot = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, import.meta.url))

export default defineConfig({
  test: {
    // 骨格のみの package にテストが無くても `pnpm test` を成功させる。
    passWithNoTests: true,
    projects: [
      {
        // root の test 設定（passWithNoTests 等）を継承する（Vitest の既定）。
        extends: true,
        root: projectRoot('./apps/automation'),
        resolve: { alias: workspaceAlias },
        test: {
          name: '@mf-automation/automation',
        },
      },
      ...workspacePackageNames.map((packageName) => ({
        extends: true,
        root: projectRoot(`./packages/${packageName}`),
        resolve: { alias: workspaceAlias },
        test: {
          name: `@mf-automation/${packageName}`,
        },
      })),
    ],
  },
})
