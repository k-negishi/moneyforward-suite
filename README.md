# MoneyForward Suite

MoneyForward ME を中心とした個人向けの自動化処理を、ひとつのモノレポに集約する。

Web 版 MoneyForward ME で手動実行している更新操作を定期実行に置き換える（第 1 弾はモバイル Suica の更新）。将来的には金融機関の更新・PayPay の取り込み・Dashboard へ広げる。

## 設計の柱

- **Hexagonal Architecture** — Domain / Application / Ports を Runtime から分離し、Lambda・Playwright・EC2・Android などの技術選択を Application Core へ持ち込まない
- **モノレポ × Application 分離** — コードと設計思想はモノレポで統合し、Runtime / Deployment / IAM / Secret は Application 境界で分離する
- **Fail Closed** — 金融データを扱う前提で、Secret 分離・最小権限・異常時の停止を優先する

現時点は Issue #2（開発基盤）の骨格のみで、各 package の中身は PoC 実装（PR2）で追加する。

## セットアップ

必要環境は Node.js `^22.20.0 || ^24.0.0 || >=26.0.0`（`.node-version` は `22`。Node 23 / 25 は非対応）、pnpm 12（`packageManager: pnpm@12.8.1` で固定）、ESM / NodeNext（TypeScript 7.0）。条件を満たさない Node では `pnpm install` が `ERR_PNPM_UNSUPPORTED_ENGINE` で失敗する（`pnpm-workspace.yaml` の `engineStrict: true`）。

```sh
corepack disable pnpm   # corepack の pnpm shim が残っていると npm からの導入が EEXIST で失敗する
npm i -g pnpm@12        # corepack 0.34.0 は pnpm 12（ネイティブバイナリ配布）を解決できないため
pnpm install
```

corepack を使っていない環境では 1 行目は不要。`pnpm-lock.yaml` は commit 対象で、依存の再現には lockfile を使う。

## コマンド

| コマンド | 内容 |
|---|---|
| `pnpm build` | 全 package を `tsc -b`（project references）でビルドする |
| `pnpm typecheck` | `tsc -b` に続けて各 package を `tsc -p tsconfig.check.json`（テスト込み・emit なし）で型検査する |
| `pnpm test` | Vitest で全 package のテストを実行する |
| `pnpm test --project @mf-suite/automation` | 単一 project のテストだけを実行する |
| `pnpm --filter @mf-suite/core build` | workspace 単位で実行する（各 package が `build` / `typecheck` / `test` を持つ） |
| `pnpm clean` | ビルド生成物（`dist` / `*.tsbuildinfo`）を削除する |
| `pnpm install --frozen-lockfile` | lockfile を変更せずに再現インストールする（CI 想定） |

## workspace 構成

- `apps/automation`（`@mf-suite/automation`）— 実行エントリ。PR2 で handler / composition-root / job-router / cli を追加する
- `packages/core`（`@mf-suite/core`）— Domain / Application / Ports。Framework / Runtime 非依存
- `packages/security`（`@mf-suite/security`）— allow-list ロガー・認証セッション管理
- `packages/adapter-moneyforward-playwright`（`@mf-suite/adapter-moneyforward-playwright`）— MoneyForwardPort の Playwright 実装
- `packages/adapter-aws`（`@mf-suite/adapter-aws`）— SecretStorePort の AWS 実装（PoC 後）

将来用の空 Application・未使用 package は作らない（設計書 §5）。

## 実装時の注意

- 相対 import には `.js` 拡張子を付ける（ESM / NodeNext の解決規則）。package 間 import を追加したら、`tsconfig.json` の `references` と `tsconfig.check.json` の `paths`（tsconfig ファイルの位置基準）も更新する。
- `packages/core` は Framework / Runtime 非依存。playwright / aws-sdk / appium 等を持ち込まない（設計書 §9 / §51）。
- テストは各 package の `test/`（`src/` の外）に置く。ビルドに含まれず `dist` へ出ず、型検査は `tsconfig.check.json` が対象にする。`@mf-suite/*` の package 名 import は、テスト実行時に `vitest.config.ts` の alias で各 package の `src/index.ts` へ解決される（テストはビルド不要）。
- Playwright のブラウザ取得（`pnpm exec playwright install chromium`）は、Playwright 依存を追加する PR2 のセットアップ手順で行う。
- CLI を実行する script（例: `refresh-suica`）は `pnpm build` を前置する（ビルド忘れで古い `dist` を実行する事故を防ぐ。実装は PR2）。

## 機密情報の取り扱い

- 認証セッション等のローカル専用ファイルは `.local/` に置く。`.local/`・`.env*`（`.env.example` を除く）・Playwright の Artifact（`test-results/` / `playwright-report/` / `blob-report/`）は git 管理外。機密ページ（認証後・金融情報を含む画面）に対して Playwright MCP の filename 保存は使わない。
- AI セッション・ログに Secret / Cookie / セッショントークン / 金融明細を載せない。`.claude/settings.json` の `.local/` deny は補助とし、運用（読ませない）を併用する。詳細は CLAUDE.md と設計書 §28〜§34 の方針。
