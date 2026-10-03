# MoneyForward Suite

MoneyForward ME を中心とした個人向けの自動化処理を、ひとつのモノレポに集約する。

Web 版 MoneyForward ME で手動実行している更新操作を定期実行に置き換える（対象は金融機関のデータ一括更新）。将来的には PayPay の取り込み・Dashboard へ広げる。

## 設計の柱

- **Hexagonal Architecture** — Domain / Application / Ports を Runtime から分離し、Lambda・Playwright・EC2・Android などの技術選択を Application Core へ持ち込まない
- **モノレポ × Application 分離** — コードと設計思想はモノレポで統合し、Runtime / Deployment / IAM / Secret は Application 境界で分離する
- **Fail Closed** — 金融データを扱う前提で、Secret 分離・最小権限・異常時の停止を優先する

現時点は開発基盤の骨格のみで、各 package の中身は PoC 実装で追加する。

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
| `pnpm typecheck` | `tsc -b` に続けて各 package を `tsc -p tsconfig.check.json`（テスト込み・emit なし）で型検査し、最後にリポジトリ横断テスト（`tests/`）を `tsc -p tests/tsconfig.check.json` で検査する |
| `pnpm lint` | Biome で lint・整形・import 整列を検査する（書き換えなし） |
| `pnpm format` | `pnpm lint` の検査内容を自動修正する（整形・import 整列・安全な lint 修正） |
| `pnpm test` | Vitest で全 package のテストとリポジトリ横断の検査（`repo-policy`）を実行する。Adapter のブラウザテストは実 chromium を使うため、初回は事前取得が必要（下記「実装時の注意」を参照） |
| `pnpm test:architecture` | Architecture Test（依存境界の検査）だけを実行する。違反時は import の `file:line` と指定子を出力する |
| `pnpm test --project @mf-suite/automation` | 単一 project のテストだけを実行する |
| `pnpm --filter @mf-suite/core build` | workspace 単位で実行する（各 package が `build` / `typecheck` / `test` を持つ） |
| `pnpm clean` | ビルド生成物（`dist` / `*.tsbuildinfo`）を削除する |
| `pnpm install --frozen-lockfile` | lockfile を変更せずに再現インストールする（CI 想定） |

### 手動ログインとセッションの再生成（session CLI）

MoneyForward ME の操作には認証済みセッションが必要になる。Password はシステムが扱わず、ローカルで手動ログインして生成したセッションを再利用する。セッション失効時は自動復旧せず、AUTH_REQUIRED として停止する。先に `pnpm --filter @mf-suite/adapter-moneyforward-playwright exec playwright install chromium` でブラウザを取得しておく。

```sh
pnpm --filter @mf-suite/adapter-moneyforward-playwright session:login   # headed で手動ログインし、セッションを保存する
pnpm --filter @mf-suite/adapter-moneyforward-playwright session:check   # 保存済みセッションの有効性を確認する（headless）
```

`session:login` は headed ブラウザでログイン画面を開く。CAPTCHA・ワンタイムパスワード・新端末確認は自動回避しないため、ユーザー自身で対応し、完了後にターミナルで Enter を押す。認証済みと確認できた場合だけセッションを保存し、確認できない場合は保存せず `status=AUTH_REQUIRED` で停止する（終了コード 2）。

セッションの保存先と権限は次のとおり（ファイルの権限が緩い場合は読み込み時に拒否する = fail closed）。

| 項目 | 内容 |
|---|---|
| 既定の保存先 | `.local/moneyforward-session.json`（git 管理外） |
| 上書き | 環境変数 `MF_SESSION_FILE` に絶対パスを指定する（相対パスは受け付けない） |
| 権限 | ファイル 0600・新規作成するディレクトリ 0700（既存ディレクトリの権限は変更しない） |

`MF_SESSION_FILE` で上書きする場合は、git 管理外かつ他者と共有しない場所を指定する（セッションは Secret として扱う）。

`session:check` は保存済みセッションを読み込み、有効性を確認する。stdout には `status=...` の 1 行（有効時は保存先の表示 1 行を追加）を出し、状態に応じた終了コードで停止する。

| status | 終了コード | 意味と対処 |
|---|---|---|
| `SESSION_VALID` | 0 | 有効。そのまま実行できる |
| `SESSION_MISSING` | 1 | セッションが無い。`session:login` で生成する |
| `SESSION_INVALID` | 1 | 破損、または他ユーザーが読める権限。`session:login` で作り直す |
| `AUTH_REQUIRED` | 2 | 失効。`session:login` で再生成する |
| `TEMPORARY_FAILURE` | 1 | 判定不能（通信・ページ取得の失敗など）。時間を置いて再実行し、改善しなければ `session:login` で作り直す |

失効・欠如・破損のときは、再生成のコマンドを stderr に固定文言で案内する。出力の契約は、stdout が `status=...` 行（有効時は保存先の表示 1 行を追加）、stderr が再生成案内などの固定文言とする。Cookie・セッショントークンの値はどの出力にも含めない。設定エラー（`MF_SESSION_FILE` の相対パス指定など）も stderr に固定文言で案内し、`TEMPORARY_FAILURE` で停止する。

トラブルシュート:

- `session:check` が `SESSION_INVALID` になる: ファイルの権限が 0600 か（`ls -l .local/`）と、内容が Playwright の storageState 形式かを確認し、`session:login` で作り直す。
- `session:login` が `status=AUTH_REQUIRED` で終わる: ログインが完了していない（Enter 前の中断・EOF）、または認証チャレンジの検知。ブラウザでログインを完了してから再実行する。
- `session:check` が `TEMPORARY_FAILURE` になる: セッションの有効性を判定できていない。ネットワークと MoneyForward ME の状態を確認して再実行する。

### 金融機関のデータ一括更新の実行（refresh-accounts CLI）

保存済みのセッションを使って、金融機関のデータ一括更新を本番と同じ Use Case で 1 回だけ実行する。先に上記の session CLI の手順でセッションを生成しておく（ブラウザの取得も同じ手順の前提）。

```sh
pnpm refresh-accounts             # headless で実行する（既定）
pnpm refresh-accounts --headed    # ブラウザを表示して実行する
```

引数は `--headed` / `--headless` だけを受け付ける。未知のフラグ・値付き・重複・位置引数は拒否し、終了コード 64 で停止する（URL・Selector・JavaScript・Shell Command・ID / Password は受け付けない）。セッションの保存先は session CLI と同じ（`MF_SESSION_FILE` の絶対パス、既定は `.local/`）。再試行・待機は CLI では行わない（実行基盤の責務）。

出力は `status=...`（失敗時は `errorCode=...` を続ける）の 1 行だけとする。Cookie・セッショントークン・金融明細はどの出力にも含めない。状態と終了コードは次のとおり。

| status | errorCode | 終了コード | 意味と対処 |
|---|---|---|---|
| `SUCCESS` | — | 0 | 一括更新の受付を確認できた（失敗の観測なし。完了確認は行わない） |
| `PARTIAL_SUCCESS` | — | 4 | 受付は確認できたが、一部の行で失敗を観測した。手動で画面の状態を確認する |
| `NO_REFRESH_NEEDED` | — | 3 | 更新不要（現時点では判定条件が未確認のため発火しない） |
| `FAILURE` | `AUTH_REQUIRED` | 2 | 処理中にセッション失効を検知。`session:login` で作り直す |
| `FAILURE` | `SESSION_MISSING` | 2 | セッションが無い。`session:login` で生成する |
| `FAILURE` | `SESSION_INVALID` | 2 | セッションが破損、または他ユーザーが読める権限。`session:login` で作り直す |
| `FAILURE` | `INVALID_JOB` | 64 | 不正入力（引数の誤り、または受理されない Job 入力）。使い方を確認する |
| `FAILURE` | その他（`TEMPORARY_FAILURE` / `REFRESH_REJECTED` / `REFRESH_NOT_ACCEPTED` / `TARGET_NOT_FOUND` / `TARGET_AMBIGUOUS` / `UNKNOWN` など） | 1 | 一時障害・拒否・判定不能。errorCode を見て対処する |

トラブルシュート:

- `status=FAILURE errorCode=TEMPORARY_FAILURE` になる: 一時障害、または判定不能。時間を置いて再実行し、改善しなければネットワークと MoneyForward ME の状態を確認する。
- `status=FAILURE errorCode=REFRESH_REJECTED` になる: MoneyForward 側が明示的に拒否・失敗した（再試行しない）。手動で画面の状態を確認する。
- `status=FAILURE errorCode=REFRESH_NOT_ACCEPTED` / `TARGET_NOT_FOUND` / `TARGET_AMBIGUOUS` になる: 受付・対象を確認できなかった。手動で画面を確認して再実行する。
- `status=FAILURE errorCode=UNKNOWN` になる: 判定不能（設定エラーなどの例外を含む）。`MF_SESSION_FILE` の指定（絶対パス）を確認する。
- 終了コード 64 になる: 引数の誤り。`--headed` / `--headless` 以外は受け付けない。

## workspace 構成

- `apps/automation`（`@mf-suite/automation`）— 実行エントリ。Lambda のハンドラー（job-router / handler / composition-root）と refresh-accounts CLI（Driving Adapter）を置く
- `packages/core`（`@mf-suite/core`）— Domain / Application / Ports。Framework / Runtime 非依存
- `packages/security`（`@mf-suite/security`）— allow-list ロガー・認証セッション管理
- `packages/adapter-moneyforward-playwright`（`@mf-suite/adapter-moneyforward-playwright`）— MoneyForwardPort の Playwright 実装
- `packages/adapter-aws`（`@mf-suite/adapter-aws`）— SecretStorePort の AWS Secrets Manager 実装（最小 IAM 権限の要件は [docs/architecture.md](docs/architecture.md) を参照）

将来用の空 Application・未使用 package は作らない（[ADR-0005](docs/adr/0005-pnpm-workspace.md)）。

## 実装時の注意

- 相対 import には `.js` 拡張子を付ける（ESM / NodeNext の解決規則）。package 間 import を追加したら、`tsconfig.json` の `references` と `tsconfig.check.json` の `paths`（tsconfig ファイルの位置基準）も更新する。
- `packages/core` は Framework / Runtime 非依存。playwright / aws-sdk / appium 等を持ち込まない（[ADR-0006](docs/adr/0006-core-runtime-independence.md)）。
- テストは各 package の `test/`（`src/` の外）に置く。ビルドに含まれず `dist` へ出ず、型検査は `tsconfig.check.json` が対象にする。`@mf-suite/*` の package 名 import は、テスト実行時に `vitest.config.ts` の alias で各 package の `src/index.ts` へ解決される（テストはビルド不要）。リポジトリ横断の検査は `tests/`（workspace package ではない）に置き、vitest の `repo-policy` プロジェクトで実行され、型検査は `tests/tsconfig.check.json` が対象にする。
- Playwright のブラウザ取得は `pnpm --filter @mf-suite/adapter-moneyforward-playwright exec playwright install chromium` で行う（Adapter のブラウザテストと CLI の実行前に必要）。テストは合成 HTML のみを描画し、実サービスへは接続しない。
- CLI を実行する script（例: `refresh-accounts`）は `pnpm build` を前置する（ビルド忘れで古い `dist` を実行する事故を防ぐ）。ルートからは `pnpm -C` で対象 package へ委譲する（`pnpm --filter` の再帰実行は失敗時の終了コードを 1 に潰すため、終了コードを契約に持つ CLI では使わない）。

## 開発補助（Claude Code）

実装は Claude Code を併用して進める。以下のプラグイン・MCP サーバー・カスタムエージェントは**開発時の支援のためのもので、プロダクトの機能ではなく、ビルド・テスト・実行時の依存にも含まれない**（無効化しても `pnpm build` / `pnpm lint` / `pnpm test` は成立する）。

### プラグイン

`.claude/settings.json` の `enabledPlugins` で、`claude-plugins-official` マーケットプレイスの2つを有効にしている。

| プラグイン | 用途 |
|---|---|
| `typescript-lsp` | TS/JS の Language Server 連携（定義ジャンプ・参照検索・エラー検査）。利用には `typescript-language-server` と `typescript` のグローバル導入が必要 |
| `security-guidance` | 編集時・応答終了時・コミット時のセキュリティレビュー（injection / XSS / SSRF / Secret 混入などの脆弱性クラス） |

### MCP サーバー

`.mcp.json` で定義する。有効化は Claude Code の確認に応じて `.claude/settings.local.json` に記録され、このファイルは git 管理外（開発者ごとの設定）。

| サーバー | 用途 |
|---|---|
| `playwright` | ブラウザ操作の補助。隔離プロファイル（`--isolated`）・画像応答の抑制・出力先 `.playwright-mcp`（git 管理外）を指定する。機密ページ（認証後・金融情報を含む画面）には使わない（[機密情報の取り扱い](#機密情報の取り扱い)） |
| `aws-knowledge` | AWS 公式ドキュメント・リージョン情報の参照 |

いずれもローカルへの事前導入は不要（`playwright` は `npx` 実行で、バージョンは `.mcp.json` で固定する。`aws-knowledge` は AWS 提供のリモートサーバーへ HTTP 接続する）。

### カスタムエージェント

`.claude/agents/` に、レビュー専用のサブエージェントを2つ置いている（CLAUDE.md の開発ワークフローで、実装完了後・コミット前に起動する）。

| エージェント | 用途 |
|---|---|
| `code-reviewer` | 変更差分の correctness と要件の充足を検証する。ADR との整合、Core / Adapter の依存境界、Playwright の成功判定、回帰リスクを主な観点とする |
| `security-reviewer` | Secret の混入、ログの allow list、認証チャレンジの扱い、fail closed の破れ、汎用脆弱性クラスを検証する |

どちらも `Read` / `Grep` / `Glob` に限定した読み取り専用で、コードは修正せず指摘のみを返す。

## 機密情報の取り扱い

- 認証セッション等のローカル専用ファイルは `.local/` に置く。`.local/`・`.env*`（`.env.example` を除く）・Playwright の Artifact（`test-results/` / `playwright-report/` / `blob-report/`）は git 管理外。機密ページ（認証後・金融情報を含む画面）に対して Playwright MCP の filename 保存は使わない。
- AI セッション・ログに Secret / Cookie / セッショントークン / 金融明細を載せない。`.claude/settings.json` の `.local/` deny は補助とし、運用（読ませない）を併用する。詳細は CLAUDE.md と [ADR-0011〜ADR-0017](docs/adr/README.md)（Security Policy・認証・Secret・ログ・Artifact）の方針。
