# Architecture Decision Records（ADR）

このディレクトリは、このリポジトリの設計判断の記録（ADR）を置く場所である。

## ADR とは

- 1 つの設計判断を 1 ファイルに記録する。決定時点の内容を保持し、承認後は書き換えない。
- 「何を決めたか」だけでなく「なぜ決めたか」「何を却下したか」を残す。
- 現在の構造の説明や要件は ADR ではない。ADR は決定の履歴であり、現在の姿は別の文書（アーキテクチャ文書・要件文書）が示す。

## 運用規約

| 項目 | 規約 |
|---|---|
| 書式 | MADR 簡略版（`template.md`）。Status / Date / Context / Decision / Consequences / Alternatives considered |
| Status | `Proposed` / `Accepted` / `Deprecated` / `Superseded by ADR-NNNN` の 4 種 |
| ファイル名 | `NNNN-slug.md`（4 桁ゼロ埋め連番）。番号は不変で、欠番を再利用しない |
| 粒度 | 1 決定 1 ファイル |
| 変更 | 承認後の ADR は書き換えない。決定を変えるときは新しい ADR を作り、旧 ADR の Status を `Superseded by ADR-NNNN` にする（本文は履歴として残す） |
| 遡及記録 | 旧設計書から移行する ADR は retrospective として、Date に原典の日付（2026-10-03）を記す |

## 決定一覧

| # | タイトル | Status | Date |
|---|---|---|---|
| [0001](0001-adopt-adr.md) | 設計判断の記録に ADR を採用する | Accepted | 2026-10-03 |
| [0002](0002-monorepo-application-boundaries.md) | モノレポと Application 境界の分離原則 | Accepted | 2026-10-03 |
| [0003](0003-hexagonal-architecture.md) | ヘキサゴナルアーキテクチャを採用する（必須） | Accepted | 2026-10-03 |
| [0004](0004-application-units-runtime-isolation.md) | Application 単位で分割し、Runtime・Deployment・Dependency を分離する | Accepted | 2026-10-03 |
| [0005](0005-pnpm-workspace.md) | パッケージ管理に pnpm workspace を採用する | Accepted | 2026-10-03 |
| [0006](0006-core-runtime-independence.md) | Core を Framework / Runtime 非依存に保つ | Accepted | 2026-10-03 |
| [0007](0007-port-granularity.md) | Port は外部 Capability 単位で定義する（過剰抽象化の禁止） | Accepted | 2026-10-03 |
| [0008](0008-composition-root.md) | Composition Root で依存を注入する | Accepted | 2026-10-03 |
| [0009](0009-single-lambda-job-router.md) | 初期 Automation は Single Lambda + Job Router で構成する | Accepted | 2026-10-03 |
| [0010](0010-no-generic-executor.md) | 汎用 Executor を禁止する（外部入力による任意操作の排除） | Accepted | 2026-10-03 |
| [0011](0011-security-policy.md) | Security Policy を機能要件より優先する（Fail Closed 等） | Accepted | 2026-10-03 |
| [0012](0012-manual-auth-session-reuse.md) | 認証は手動ログインとセッション再利用で行う | Accepted | 2026-10-03 |
| [0013](0013-secret-isolation.md) | Secret を Application 単位で分離する | Accepted | 2026-10-03 |
| [0014](0014-iam-per-application.md) | IAM Role を Application 単位で分離する | Accepted | 2026-10-03 |
| [0015](0015-no-auth-challenge-bypass.md) | 認証チャレンジを自動回避しない | Accepted | 2026-10-03 |
| [0016](0016-allow-list-logging.md) | ログを Allow List 方式にする | Accepted | 2026-10-03 |
| [0017](0017-no-production-artifacts.md) | Production Artifact を恒常保存しない | Accepted | 2026-10-03 |
| [0018](0018-moneyforward-adapter-boundary.md) | MoneyForward Adapter の境界を閉じる（Playwright を Core へ漏らさない） | Accepted | 2026-10-03 |
| [0019](0019-semantic-locators.md) | Locator は意味ベースで選択する | Accepted | 2026-10-03 |
| [0020](0020-verify-success-by-state-change.md) | 成功判定は状態変化で行う | Accepted | 2026-10-03 |
| [0021](0021-retry-orchestration.md) | Retry と実行基盤（Step Functions・Lambda Timeout） | Accepted | 2026-10-03 |
| [0022](0022-architecture-test.md) | Architecture Test で境界を検証する | Accepted | 2026-10-03 |
| [0023](0023-monorepo-ci-affected-builds.md) | CI/CD をモノレポ対応（affected build）にする | Accepted | 2026-10-03 |
| [0024](0024-iac-per-deployment-unit.md) | Infrastructure as Code を Deployment Unit 単位で管理する | Accepted | 2026-10-03 |
| [0025](0025-external-system-boundaries.md) | 外部システム境界を Adapter で分離する（MoneyForward と PayPay） | Accepted | 2026-10-03 |
| [0026](0026-adr-trigger-policy.md) | ADR の作成トリガーを定め、開発フローに組み込む | Accepted | 2026-10-03 |
| [0027](0027-review-subagent-migration.md) | レビュー工程をリポジトリ専用サブエージェント 2 体へ移行する | Proposed | 2026-10-03 |
| [0028](0028-refresh-accounts-initial-job.md) | 初期 Job を refresh-accounts（金融機関の一括更新と Suica 更新）とする | Superseded by ADR-0029 | 2026-10-03 |
| [0029](0029-exclude-mobile-suica.md) | モバイル Suica を対象から外し、初期 Job を金融機関のデータ一括更新に限定する | Accepted | 2026-10-03 |
| [0030](0030-proposal-staging.md) | 企画段階の文書を proposals に置き、決着時に ADR へ蒸留する | Accepted | 2026-10-03 |
| [0031](0031-moneyforward-port-operations.md) | MoneyForwardPort の操作を verifySession と refreshAccounts の 2 つに絞る | Proposed | 2026-10-03 |
| [0032](0032-opaque-secret-values.md) | 認証セッションと Secret の値を opaque 型で表す | Proposed | 2026-10-03 |
| [0033](0033-error-code-retry-classification.md) | ErrorCode の語彙と再試行可否を 1 つの対応表で定義する | Proposed | 2026-10-03 |
| [0034](0034-architecture-test-detector.md) | Architecture Test を自作の import 検出器で実装する | Proposed | 2026-10-03 |
| [0035](0035-lint-format-with-biome.md) | lint と format に Biome を採用する | Accepted | 2026-10-03 |
