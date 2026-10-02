# 要件とロードマップ

この文書は MoneyForward Suite の要件とロードマップをまとめる生きている文書である。進捗に応じて更新する。決定の理由は [ADR](adr/README.md) に、現在の構造は [architecture.md](architecture.md) にある。

## 概要

`MoneyForward Suite` は、MoneyForward ME を中心とした個人向け自動化処理を集約するシステムである。MoneyForward ME に関連する複数の自動化機能を、同一 GitHub Repository で継続的に管理する。

最初の実装対象は `refresh-suica` とする。将来的には MoneyForward ME の各種操作・PayPay 自動取り込み・Dashboard へ広げる可能性があるが、将来機能の具体的な実装方式は必要になった時点で設計する。

System of Record は MoneyForward ME とする。

## 初期 Job: refresh-suica

目的は、MoneyForward ME に連携されたモバイル Suica について、ユーザーが Web 版 MoneyForward ME 上で手動実行している更新操作を自動化することである。処理概要は次のとおり。

```text
MoneyForward MEへアクセス
        ↓
認証状態確認
        ↓
モバイルSuicaを特定
        ↓
状態取得
        ↓
更新可否判断
        ↓
必要な場合のみ更新
        ↓
更新結果確認
```

認証は手動ログインとセッション再利用で行う（ADR-0012）。成功判定は状態変化で行い（ADR-0020）、必要な場合のみ更新する。

## 定期実行

`refresh-suica` は 1 日 1 回実行する。初期設定として早朝帯（例: 05:00 JST）を想定し、実行時刻は設定可能とする。

実行基盤は EventBridge Scheduler → Step Functions → Automation Lambda とし、Retry（初回込み最大 3 試行・1 時間間隔）の待機は Step Functions が担当する。詳細は ADR-0021（Retry と実行基盤）を参照。

## 初期 MVP

実装対象:

```text
apps/automation

refresh-suica

MoneyForward Port

Playwright Adapter

AWS Adapter

Security

Hexagonal Architecture Boundary
```

## 実装順序

Phase 1:

```text
1. pnpm workspace
2. Hexagonal Architecture境界
3. Core / Port定義
4. MoneyForward Playwright Adapter
5. Manual Authentication
6. Session Reuse
7. RefreshSuica Use Case
8. Job Router
9. CLI Driving Adapter
10. Unit Test
11. Architecture Test
12. Local E2E
13. Headless確認
```

Phase 2:

```text
14. Automation Docker Image
15. Lambda
16. Secrets Manager / KMS
17. Step Functions
18. EventBridge Scheduler
19. CI/CD
```

将来 Phase:

```text
PayPay Worker
Dashboard
その他Automation
```

## 現時点で実装しないもの

MVP では以下を実装しない。これらは将来要件としてのみ考慮する。

```text
PayPay自動取り込み

Android Emulator

EC2 Worker

Dashboard

Database

Analytics

MCP

AI機能
```

## 将来構想

いずれも現時点では確定要件ではない。実装方式は必要になった時点で設計する。

- **PayPay 自動取り込み**: PayPay 側の情報を取得し、MoneyForward ME で管理可能な形へ反映する。取得方法・同期方法は未決定。モバイルアプリ操作が必要になった場合は EC2 + Android Emulator + Appium / UIAutomator2 等を利用する可能性がある（技術検証後に決定）。PayPay UI 操作と MoneyForward 反映は別 Adapter に分離する（ADR-0025）。
- **apps/paypay-worker**: PayPay 自動取り込みを実装する場合の Application。Lambda では実現できない処理であっても、同一 Repository に自然に Application として追加できることを重視する。Runtime・操作方法は現時点では確定しない。
- **Dashboard（apps/web）**: MoneyForward 関連情報を確認する画面を提供する可能性がある。UI Framework・Backend 方式・Database・認証方式・Hosting・データ取得方式は現時点では決定しない。追加できる Repository 構造を維持する（ADR-0004）。
