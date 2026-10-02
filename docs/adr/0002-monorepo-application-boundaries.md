# 0002. モノレポと Application 境界の分離原則

- Status: Accepted
- Date: 2026-10-03

## Context

原典: 旧設計書 §2・§53（遡及記録）

MoneyForward ME を中心とした複数の自動化機能を扱うにあたり、Repository の単位と Application・Runtime・Deployment・IAM・Secret の単位を混同しないことが出発点となった。同一 Repository に置くことは、同一 Application・同一 Runtime・同一 Deployment・同一 IAM Role・同一 Secret であることを意味しない。一方で、MoneyForward 関連のあらゆる処理を同じ Runtime へ押し込むモノリスも、関連する Automation・PayPay 連携・Dashboard を別 Repository へ無秩序に分散させることも避ける必要があった。

## Decision

モノレポを採用し、関連する Application・Domain・Adapter・Infrastructure を同一 Repository で一貫して管理する。モノレポは「すべてを同一 Lambda や同一コンテナで動かすこと」を意味しない。以下の区別を最重要設計原則とする。

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

コードと設計思想はモノレポで統合し、Runtime・Deployment・IAM・Secret は Application 境界で分離する。

## Consequences

- 各 Application は独立して Runtime・Deployment・IAM・Secret を選択でき、Lambda 前提の設計にならない。
- Application 境界を越える共有（Runtime・Secret・IAM）は禁止方向の制約となり、Architecture Test（ADR-0022）等の検証対象になる。
- Repository は 1 つに統合されるため、境界の規律は文書とテストで維持する必要がある。

## Alternatives considered

- MoneyForward 関連のあらゆる処理を同じ Runtime へ押し込むモノリス: 原典（§53）で明示的に否定されている。
- 関連する Automation・将来の PayPay 連携・Dashboard を別 Repository へ無秩序に分散させる: 原典（§53）で明示的に否定されている。
