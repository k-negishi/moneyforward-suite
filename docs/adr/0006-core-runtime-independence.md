# 0006. Core を Framework / Runtime 非依存に保つ

- Status: Accepted
- Date: 2026-10-03

## Context

原典: 旧設計書 §9・§10・§12（遡及記録）

モノレポで複数 Application を共存させるには、共有 Core へ Runtime 固有 Dependency を持ち込まないことが前提となる。例えば packages/core に playwright・aws-sdk・appium・android-sdk・EC2 固有コードが入ると、Lambda 用 Artifact と PayPay Worker 用 Artifact の分離が崩れる。

## Decision

Application Core を Framework / Runtime 非依存とする。Core には Use Case・Domain Rule・Value Object・Port・Application Result・Domain Error を配置する。

Core から以下への依存を禁止する。

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

将来 PayPay Worker を追加しても Android 関連 Dependency を Automation Lambda へ含めず、逆に PayPay Worker へ不要な Lambda 固有 Dependency を持ち込まない。

## Consequences

- Core はどの Runtime でも利用でき、Application ごとの Dependency Graph 分離が成立する。
- 依存の混入は Architecture Test（ADR-0022）で検出する。
- Core に置けるのは技術非依存の概念に限られ、外部システムの操作は Port 経由になる（ADR-0007）。

## Alternatives considered

- packages/core へ playwright / aws-sdk / appium / android-sdk / EC2 固有コードを含める: §9 で禁止例として明示されている。
- Android 関連 Dependency を Automation Lambda の Docker Image へ含める: §10 で禁止されている。
