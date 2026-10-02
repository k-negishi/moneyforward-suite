# 0004. Application 単位で分割し、Runtime・Deployment・Dependency を分離する

- Status: Accepted
- Date: 2026-10-03

## Context

原典: 旧設計書 §4・§7・§8・§36・§41・§42（遡及記録）

将来構成として apps/automation（AWS Lambda）、apps/paypay-worker（EC2 / Android Emulator）、apps/web（Web Runtime）を想定し、Application ごとに Runtime を選択できることを必須とした。Lambda はあくまで現在の apps/automation に適した Runtime であり、Repository 全体に「Everything must run on Lambda」という制約は設けない。Lambda に適さない処理（Android Emulator・長時間常駐 Browser・GUI Automation・Persistent Device Session 等）は EC2・ECS 等を Runtime として選択可能とする。

## Decision

Application 単位で分割し、Runtime・Deployment・Dependency を分離する。

- Deployment Unit は Application 単位とする（apps/automation → Lambda、apps/paypay-worker → EC2 等、apps/web → Web Runtime）。Repository 全体を 1 つの Artifact として Deploy する必要はない。
- Application ごとの Dependency Graph を分離する。Android 関連 Dependency（Android SDK・Appium・UIAutomator2・Emulator 関連）を Automation Lambda の Docker Image へ含めず、逆に PayPay Worker へ不要な Lambda 固有 Dependency を持ち込まない。
- Automation Lambda は PayPay Adapter へ依存しない。

## Consequences

- Application ごとに最適な Runtime を選べ、CI/CD も Application 単位の Pipeline にできる（ADR-0023）。
- モノレポ内で Dependency 境界を維持するため、Architecture Test（ADR-0022）で検証する。
- 将来 Application（paypay-worker・web）の具体的な実装方式は必要になった時点で設計する。

## Alternatives considered

- Repository 全体を Lambda 前提で設計する: §51 で明示的に禁止されている。
- Lambda に適さない処理を Lambda へ無理に収める: §41 で否定されている。
