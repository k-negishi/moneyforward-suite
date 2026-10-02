# 0024. Infrastructure as Code を Deployment Unit 単位で管理する

- Status: Accepted
- Date: 2026-10-03

## Context

原典: 旧設計書 §40（遡及記録）

Infrastructure を Application と同じ Repository で管理するため、定義の単位と置き場所を決める必要があった。

## Decision

Infrastructure も同一 Repository で管理可能とする。

```text
infra/
├─ automation/
├─ paypay-worker/
└─ web/
```

Deployment Unit ごとに Infrastructure Definition を分離する。

## Consequences

- Application の追加に合わせて infra の定義を追加する構造になる。
- Deployment Unit の分離（ADR-0004）と対になり、Infrastructure の変更範囲も Application 単位になる。

## Alternatives considered

原典（旧設計書）に代替案の記録はない。
