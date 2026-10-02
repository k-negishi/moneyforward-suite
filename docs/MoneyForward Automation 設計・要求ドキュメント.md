# MoneyForward Automation 設計・要求ドキュメント

## 1. 概要

`MoneyForward Automation` は、MoneyForward MEを中心とした個人向け自動化処理を集約するシステムである。

MoneyForward MEに関連する複数の自動化機能を、同一GitHub Repositoryで継続的に管理する。

最初の実装対象は以下とする。

```text
refresh-suica
```

MoneyForward MEに連携されたモバイルSuicaについて、ユーザーがWeb版MoneyForward ME上で手動実行している更新操作を自動化する。

将来的には以下のような機能を追加する可能性がある。

```text
MoneyForward Automation

├─ MoneyForward ME自動操作
│  ├─ モバイルSuica更新
│  ├─ 金融機関更新
│  ├─ 手動資産更新
│  └─ その他MoneyForward操作
│
├─ PayPay自動取り込み
│  └─ Android実機 / Android Emulatorを利用する可能性あり
│
└─ Dashboard
   └─ MoneyForward関連情報を確認する画面
```

ただし、将来機能の具体的な実装方式は必要になった時点で設計する。

---

# 2. 最重要設計原則

本Repositoryでは以下を明確に区別する。

```text
Same Repository
≠
Same Application
≠
Same Runtime
≠
Same Deployment
≠
Same IAM Role
≠
Same Secret
```

モノレポとは、

> 関連するApplication・Domain・Adapter・Infrastructureを同一Repositoryで一貫して管理する

ことを意味する。

すべてを同一Lambdaや同一コンテナで動かすことを意味しない。

---

# 3. アーキテクチャ方針

以下を採用する。

```text
Monorepo
+
Multiple Applications
+
Hexagonal Architecture
+
Independent Deployment Units
```

**ヘキサゴナルアーキテクチャは必須要件とする。**

初期のMoneyForward Automation Jobについては、

```text
Modular Monolith
+
Single Lambda
```

とする。

ただしこれは `apps/automation` 内部に限定した方針である。

---

# 4. 想定する将来構成

```text
                    GitHub Repository
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
         ▼                 ▼                 ▼
 apps/automation   apps/paypay-worker     apps/web
         │                 │                 │
         ▼                 ▼                 ▼
 AWS Lambda         EC2 / Android       Web Runtime
                     Emulator
         │                 │
         ▼                 ▼
 MoneyForward ME          PayPay
```

ApplicationごとにRuntimeを選択できることを必須とする。

---

# 5. Repository構造

初期構成は以下を基本とする。

```text
moneyforward-automation/
│
├─ apps/
│   └─ automation/
│       ├─ src/
│       │   ├─ handler.ts
│       │   ├─ composition-root.ts
│       │   └─ job-router.ts
│       └─ package.json
│
├─ packages/
│   ├─ core/
│   │   └─ src/
│   │       ├─ application/
│   │       ├─ domain/
│   │       └─ ports/
│   │
│   ├─ adapter-moneyforward-playwright/
│   ├─ adapter-aws/
│   ├─ security/
│   └─ contracts/
│
├─ infra/
│   └─ automation/
│
├─ package.json
├─ pnpm-workspace.yaml
├─ pnpm-lock.yaml
└─ README.md
```

将来的には例えば以下のように拡張できること。

```text
apps/
├─ automation/
├─ paypay-worker/
└─ web/

packages/
├─ core/
├─ adapter-moneyforward-playwright/
├─ adapter-aws/
├─ adapter-paypay-android/
├─ security/
└─ contracts/

infra/
├─ automation/
├─ paypay-worker/
└─ web/
```

ただし、将来用のDirectoryやPackageを現時点で空作成する必要はない。

---

# 6. Workspace

Package Managerは `pnpm` を第一候補とする。

```yaml
packages:
  - apps/*
  - packages/*
```

各Applicationは必要なworkspace packageだけに依存する。

---

# 7. Application単位

## 7.1 automation

MoneyForward MEに対する自動操作を実行するApplication。

初期Runtime：

```text
AWS Lambda Container
```

初期Job：

```text
refresh-suica
```

MoneyForward系の軽量なAutomation Jobは、当面このApplicationへ集約する。

---

## 7.2 paypay-worker

将来的にPayPay自動取り込みを実装する場合のApplication。

例えばPayPayのモバイルアプリ操作が必要となった場合、

```text
EC2
+
Android Emulator
+
Appium / UIAutomator2
```

等のRuntime構成が必要になる可能性がある。

ただし現時点ではRuntime・操作方法を確定しない。

重要なのは、Lambdaでは実現できない処理であっても、同一Repositoryに自然にApplicationとして追加できることである。

---

## 7.3 web

将来的にMoneyForward関連情報を確認するための画面を作成し、ダッシュボード機能を提供する可能性がある。

現時点では以下を決定しない。

- UI Framework
- Backend方式
- Database
- 認証方式
- Hosting
- データ取得方式

---

# 8. ApplicationごとのDeployment

Deployment UnitはApplication単位とする。

```text
apps/automation
→ Lambda

apps/paypay-worker
→ EC2等

apps/web
→ Web Runtime
```

Repository全体を1つのArtifactとしてDeployする必要はない。

---

# 9. Runtime依存の分離

Runtime固有のDependencyを共有Coreへ含めてはならない。

例えば以下は禁止する。

```text
packages/core
├─ playwright
├─ aws-sdk
├─ appium
├─ android-sdk
└─ ec2 specific code
```

CoreはFramework / Runtime非依存とする。

---

# 10. LambdaへのAndroid依存混入禁止

将来PayPay Workerを追加しても、

```text
Android SDK
Appium
UIAutomator2
Emulator関連Dependency
```

をAutomation LambdaのDocker Imageへ含めてはならない。

逆にPayPay Workerへ、不必要なLambda固有Dependencyを持ち込まない。

モノレポであってもApplicationごとのDependency Graphを分離する。

---

# 11. Hexagonal Architecture

すべてのBusiness Applicationでヘキサゴナルアーキテクチャを採用する。

基本構造：

```text
Driving Adapter
      ↓
Input Port
      ↓
Application Core
      ↓
Output Port
      ↓
Driven Adapter
```

依存方向はApplication Coreへ向ける。

---

# 12. Application Core

Coreには以下を配置する。

```text
Use Case
Domain Rule
Value Object
Port
Application Result
Domain Error
```

Coreから以下への依存は禁止する。

```text
Playwright
AWS SDK
Lambda
EC2
Appium
UIAutomator2
Android SDK
Web Framework
```

---

# 13. Adapter

外部システム・Frameworkへの依存はAdapterへ閉じ込める。

例：

```text
MoneyForwardPort
       ↑
PlaywrightMoneyForwardAdapter
```

将来的には、

```text
PayPayPort
       ↑
AndroidPayPayAdapter
       ↑
Appium / UIAutomator2
```

のような構成を取り得る。

ただしPayPay実装方式は現時点では要求として固定しない。

---

# 14. Portの粒度

ヘキサゴナルアーキテクチャは必須だが、過剰な抽象化は禁止する。

禁止例：

```text
BrowserPort
PagePort
ButtonPort
ClickPort
SelectorPort
```

外部Capability単位でPortを定義する。

例：

```text
MoneyForwardPort

SecretStorePort

LoggerPort

将来:
PayPayPort
```

---

# 15. Composition Root

Concrete Adapterの生成およびPortへの注入は各ApplicationのComposition Rootで行う。

例：

```text
apps/automation
└─ composition-root.ts
```

概念：

```typescript
const moneyForward =
  new PlaywrightMoneyForwardAdapter(...);

const secrets =
  new AwsSecretsManagerAdapter(...);

const useCase =
  new RefreshSuicaUseCase(
    moneyForward,
    secrets,
  );
```

Application Core内でConcrete Adapterを直接生成しない。

---

# 16. 初期Automation構成

初期段階では、

```text
apps/automation
       ↓
Single Lambda
       ↓
Job Router
       ↓
Use Cases
```

とする。

MoneyForward関連Jobを追加するたびにLambda Functionを増やす必要はない。

---

# 17. Job Router

Lambdaへの入力によってJobを選択する。

```json
{
  "job": "refresh-suica"
}
```

Allow List方式とする。

```typescript
switch (event.job) {
  case "refresh-suica":
    return executeRefreshSuica();

  default:
    throw new InvalidJobError();
}
```

---

# 18. 汎用Executor禁止

外部入力から任意操作を指定できる設計は禁止する。

禁止例：

```json
{
  "url": "...",
  "selector": "...",
  "action": "click"
}
```

以下を外部から自由に実行できてはならない。

- 任意URL
- 任意Selector
- 任意JavaScript
- 任意Shell Command
- 任意Playwright処理
- 任意Appium処理

---

# 19. 初期Job: refresh-suica

目的：

MoneyForward ME上のモバイルSuica更新操作を自動化する。

処理概要：

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

---

# 20. MoneyForward Adapter

MoneyForward ME Web版の操作はPlaywright Adapterへ閉じ込める。

Application Coreへ以下を漏らさない。

```text
Page
Locator
Browser
BrowserContext
```

---

# 21. Locator

MoneyForward Adapterでは位置依存Selectorを原則使用しない。

優先順位：

1. role
2. accessible name
3. visible text
4. stable attribute
5. CSS selector

禁止例：

```text
3番目の更新ボタン
:nth-child(...)
```

---

# 22. 成功判定

更新ボタンのクリック成功だけで `SUCCESS` としない。

最低限、

```text
更新要求
 ↓
MoneyForward側で受付
 ↓
状態変化
```

を確認する。

---

# 23. 定期実行

`refresh-suica` は1日1回実行する。

初期設定として早朝帯を想定する。

例：

```text
05:00 JST
```

実行時刻は設定可能とする。

---

# 24. Retry

一時障害のみRetryする。

```text
Attempt #1
     ↓
Retryable
     ↓
Wait 1 hour
     ↓
Attempt #2
     ↓
Retryable
     ↓
Wait 1 hour
     ↓
Attempt #3
```

初回込み最大3試行とする。

---

# 25. Retry Orchestration

Lambda内部で長時間待機してはならない。

初期構成：

```text
EventBridge Scheduler
        ↓
Step Functions
        ↓
Automation Lambda
```

Step Functionsが1時間のWaitを担当する。

---

# 26. Lambda Timeout

初期値：

```text
5 minutes
```

通常処理は、

```text
30 seconds - 2 minutes
```

程度を目標とする。

---

# 27. Authentication

MVPではMoneyForward ID / Passwordによる自動ログインを実装しない。

ローカル環境でユーザーが手動ログインし、認証セッションを生成する。

セッション失効時：

```text
AUTH_REQUIRED
```

として停止する。

---

# 28. Security Policy

金融関連サービスを扱うため、セキュリティ要件を機能要件より優先する。

基本原則：

```text
Fail Closed

Least Privilege

Secret Isolation

Minimal Logging

Runtime Isolation
```

---

# 29. Secret Isolation

ApplicationごとにSecret Accessを分離する。

例えば将来、

```text
automation
→ MoneyForward Session

paypay-worker
→ PayPay関連Secret
```

となる場合、不要な相互アクセスを許可してはならない。

---

# 30. 同一RepositoryとSecret

以下を必須原則とする。

```text
Same Repository
≠
Shared Secrets
```

PayPay Workerが追加されたからといって、PayPay CredentialをAutomation Lambdaへ渡さない。

MoneyForward Sessionが不要なApplicationにはMoneyForward Sessionを渡さない。

---

# 31. IAM

ApplicationごとにIAM Roleを分離する。

例：

```text
automation-runtime-role

paypay-worker-role

future-web-role
```

IAM Roleの共有を前提としない。

Least Privilegeを適用する。

---

# 32. 認証回避禁止

以下を自動回避しない。

- CAPTCHA
- OTP
- 追加本人確認
- 新端末確認
- その他サービス側のSecurity Challenge

必要な場合は安全に停止する。

---

# 33. ログ

ログはAllow List方式とする。

基本的に以下のみ記録する。

```text
timestamp
application
job
status
attempt
durationMs
errorCode
```

以下をログへ出力しない。

```text
Password
Cookie
Session Token
storageState
金融明細
カード情報
HTML
DOM
```

---

# 34. Production Artifact

金融Applicationでは原則として以下を恒常保存しない。

```text
Screenshot
HTML
DOM Dump
HAR
Trace
Video
```

Android Automationについても、画面録画・Screenshot等に金融情報が含まれる可能性があるため同様とする。

ローカル開発時のみ必要最小限許可する。

---

# 35. Architecture Test

CIでArchitecture Boundaryを検証する。

最低限以下を禁止する。

```text
core → playwright

core → aws-sdk

core → appium

core → android

core → lambda

core → ec2
```

また、

```text
apps/automation
→ paypay-worker implementation
```

のようなApplication間の不適切なRuntime依存も禁止する。

---

# 36. Dependency管理

ApplicationごとのDependencyを明確にする。

例：

```text
apps/automation
  ↓
adapter-moneyforward-playwright
  ↓
playwright
```

将来：

```text
apps/paypay-worker
  ↓
adapter-paypay-android
  ↓
appium
```

Automation LambdaはPayPay Adapterへ依存しない。

---

# 37. CI/CD

CI/CDもモノレポ対応とする。

基本方針：

```text
変更されたApplication
+
影響を受けるShared Package
```

に応じて必要なBuild/Testを行う。

---

# 38. Deployment Pipeline

例えば、

```text
apps/automation changed
        ↓
Automation Test
        ↓
Automation Image Build
        ↓
Lambda Deploy
```

将来的には、

```text
apps/paypay-worker changed
        ↓
PayPay Worker Test
        ↓
PayPay Worker Deploy
```

とする。

`apps/paypay-worker` の変更だけでAutomation LambdaをDeployする必要はない構成を目指す。

---

# 39. Shared Package変更

`packages/core` 等の共有Packageを変更した場合は、それを利用するApplicationすべてについてTestを実行する。

必要に応じて将来、

```text
Turborepo
Nx
```

等のaffected build機構を導入できる。

MVP時点では必須としない。

---

# 40. Infrastructure as Code

Infrastructureも同一Repositoryで管理可能とする。

```text
infra/
├─ automation/
├─ paypay-worker/
└─ web/
```

Deployment UnitごとにInfrastructure Definitionを分離する。

---

# 41. EC2等の長時間Runtime

Lambdaに適さない処理が発生した場合、Lambdaへ無理に収めない。

例えば、

```text
Android Emulator
長時間常駐Browser
GUI Automation
Persistent Device Session
```

等が必要な場合は、

```text
EC2
ECS
その他適切なCompute
```

をApplication Runtimeとして選択可能とする。

---

# 42. Lambdaを標準Runtimeとしない

本Repository全体として、

```text
Everything must run on Lambda
```

という制約は設けない。

Lambdaはあくまで現在の `apps/automation` に適したRuntimeである。

---

# 43. PayPay自動取り込み

将来追加候補として、

```text
PayPay自動取り込み
```

を明示的に想定する。

目的はPayPay側の情報を取得し、MoneyForward MEで管理可能な形へ反映することである。

具体的な取得方法・同期方法は現時点では決定しない。

---

# 44. PayPay Runtime候補

将来的にモバイルアプリ操作が必要になった場合、

```text
EC2
+
Android Emulator
+
Appium / UIAutomator2
```

等を利用する可能性がある。

この構成は現時点での確定要件ではない。

技術検証後に決定する。

---

# 45. PayPayとMoneyForwardの結合

将来PayPay取り込みを実装する場合でも、

```text
PayPay UI操作
```

と、

```text
MoneyForward反映
```

を1つの巨大Adapterへ混在させない。

概念的には、

```text
PayPayPort
     ↑
PayPay Adapter

MoneyForwardPort
     ↑
MoneyForward Adapter
```

として外部システム境界を分離する。

Application Use Caseが両Portをオーケストレーションする。

---

# 46. 将来Dashboard

将来的に画面を作成し、ダッシュボード機能を提供する可能性がある。

そのため、

```text
apps/web
```

を追加できるRepository構造を維持する。

現時点ではそれ以上の詳細を要求しない。

---

# 47. 現時点で実装しないもの

MVPでは以下を実装しない。

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

これらは将来要件としてのみ考慮する。

---

# 48. 初期MVP

実装対象：

```text
apps/automation

refresh-suica

MoneyForward Port

Playwright Adapter

AWS Adapter

Security

Hexagonal Architecture Boundary
```

---

# 49. 実装順序

Phase 1：

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

Phase 2：

```text
14. Automation Docker Image
15. Lambda
16. Secrets Manager / KMS
17. Step Functions
18. EventBridge Scheduler
19. CI/CD
```

将来Phase：

```text
PayPay Worker
Dashboard
その他Automation
```

---

# 50. Codex MUST

- Monorepoとして構築する
- ヘキサゴナルアーキテクチャを採用する
- Application単位でRuntimeを分離可能にする
- Application CoreをFramework非依存にする
- Port / Adapter境界を明示する
- MoneyForwardとPayPay等の外部System境界を分離する
- Runtime固有DependencyをCoreへ入れない
- ApplicationごとにDeployment Artifactを分離可能にする
- ApplicationごとにSecret/IAMを分離可能にする
- Architecture Testを導入する
- Fail Closedとする

---

# 51. Codex MUST NOT

- Repository全体をLambda前提で設計しない
- Android関連DependencyをLambda Artifactへ入れない
- PlaywrightをCoreへ依存させない
- AppiumをCoreへ依存させない
- AWS SDKをCoreへ依存させない
- Application間でConcrete Adapterを直接共有しない
- すべてのApplicationでIAM Roleを共有しない
- すべてのApplicationでSecretを共有しない
- 汎用Automation Executorを作らない
- CAPTCHA等を回避しない
- TLS検証を無効化しない
- Secret・金融情報をログ出力しない

---

# 52. 最終採用方針

```text
Repository
→ Monorepo

Workspace
→ pnpm workspace

Architecture
→ Hexagonal Architecture
→ 必須

Applications
→ Runtimeごとに独立

Current Automation
→ Modular Monolith
→ Single Lambda

Future PayPay
→ 独立Application
→ EC2 + Android Emulator等も許容

Future Dashboard
→ 独立Web Application

MoneyForward Browser
→ Playwright Adapter

Future Android Automation
→ 専用Adapter

Deployment
→ Application単位

IAM
→ Application単位

Secrets
→ Application単位

Schedule
→ Daily

Retry
→ 1時間間隔
→ 最大2回Retry

System of Record
→ MoneyForward ME

Security
→ Fail Closed
→ Least Privilege
→ Secret Isolation
```

---

# 53. 設計思想

本Repositoryは、

> **MoneyForward関連のあらゆる処理を同じRuntimeへ押し込むモノリス**

にはしない。

一方で、

> **関連するAutomation・将来のPayPay連携・Dashboardを別Repositoryへ無秩序に分散させる**

ことも避ける。

そのため、

> **コードと設計思想はモノレポで統合し、Runtime・Deployment・IAM・SecretはApplication境界で分離する。**

ヘキサゴナルアーキテクチャによって、Lambda、Playwright、EC2、Android Emulator、Appium等の技術選択をApplication Coreから切り離す。

これにより、現在のSuica自動更新から始めても、将来的に

```text
Lambda Automation
+
EC2 Android Automation
+
Web Dashboard
```

が同一Repository内で無理なく共存できる構造を維持する。