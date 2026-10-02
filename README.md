# MoneyForward Automation Suite

MoneyForward の操作を自動化するためのモノレポ。設計は [MoneyForward Automation 設計・要求ドキュメント](<docs/MoneyForward Automation 設計・要求ドキュメント.md>) を参照する。

現時点は Issue #2（開発基盤）の骨格のみで、各 package の中身は PoC 実装（PR2）で追加する。

## 必要環境

| 項目 | 方針 |
|---|---|
| Node.js | 22（`.node-version` に `22` を記載。nodebrew 等で導入する） |
| pnpm | 12（`package.json` の `packageManager: pnpm@12.8.1` で固定。npm から導入する） |
| モジュール方式 | ESM（`"type": "module"`）。TypeScript 7.0 の `module` / `moduleResolution` は `nodenext` |

`pnpm-lock.yaml` は commit 対象。依存の再現には lockfile を使う。

## セットアップ

```sh
# 1. corepack の pnpm shim が残っている場合は無効化する
#    （残っていると npm でのインストールが EEXIST で失敗する）
corepack disable pnpm

# 2. pnpm 12 を導入する
#    corepack 0.34.0 は pnpm 12（ネイティブバイナリ配布）の実行エントリを解決できず
#    "Cannot find module .../bin/pnpm.cjs" で失敗するため、npm から導入する
npm i -g pnpm@12

# 3. 依存を導入する
pnpm install
```

corepack の shim を使っていない環境では `corepack enable pnpm` は不要。

## コマンド

| コマンド | 内容 |
|---|---|
| `pnpm build` | 全 package を TypeScript プロジェクト参照（`tsc -b`）でビルドする |
| `pnpm typecheck` | `build` と同じ。プロジェクト参照ビルドは型検査を内包し、増分ビルドで高速なため分けていない |
| `pnpm test` | Vitest で全 workspace package のテストを実行する |
| `pnpm test --project @mf-automation/automation` | 単一 project のテストだけを実行する |
| `pnpm --filter @mf-automation/core build` | workspace 単位で実行する（各 package が `build` / `typecheck` / `test` を持つ） |
| `pnpm clean` | ビルド生成物（`dist` / `*.tsbuildinfo`）を削除する |
| `pnpm install --frozen-lockfile` | lockfile を変更せずに再現インストールする（CI 想定） |

## workspace 構成

```text
apps/
  automation/                       @mf-automation/automation（実行エントリ。PR2 で handler / composition-root / job-router / cli を追加）
packages/
  core/                             @mf-automation/core（Domain / Application / Ports。Framework / Runtime 非依存）
  security/                         @mf-automation/security（allow-list ロガー・認証セッション管理）
  adapter-moneyforward-playwright/  @mf-automation/adapter-moneyforward-playwright（MoneyForwardPort の Playwright 実装）
  adapter-aws/                      @mf-automation/adapter-aws（SecretStorePort の AWS 実装。PoC 後）
```

将来用の空 Application・未使用 package は作らない（設計書 §5）。

## 実装時の注意

- ESM のため、相対 import には `.js` 拡張子が必要（NodeNext の解決規則）。
- package 間 import を追加したら、その package の `tsconfig.json` の `references` に依存先を追加する（`tsc -b` のビルド順はここから決まる）。
- `packages/core` は Framework / Runtime 非依存。playwright / aws-sdk / appium 等を持ち込まない（設計書 §9 / §51）。
- テストは各 package の `src/**/*.test.ts` に置く。`tsc -b` の対象外とし `dist` へ出さない。
- `@mf-automation/*` の package 名 import は、テスト実行時に `vitest.config.ts` の alias で各 package の `src/index.ts` へ解決される（テストはビルド不要）。
- Playwright のブラウザ取得（`pnpm exec playwright install chromium`）は、Playwright 依存を追加する PR2 のセットアップ手順で行う。

## 機密情報の取り扱い

- 認証セッション等のローカル専用ファイルは `.local/` に置く（git 管理外。AI セッションは `.local/` を読まない）。
- `.env*` は git 管理外（`.env.example` のみ追跡可）。
- Playwright の Artifact（`test-results/` / `playwright-report/` / `blob-report/`）は git 管理外。
