# 0014. IAM Role を Application 単位で分離する

- Status: Accepted
- Date: 2026-10-03

## Context

原典: 旧設計書 §31（遡及記録）

Application ごとに Runtime が異なるため、IAM Role の設計単位を決める必要があった。

## Decision

Application ごとに IAM Role を分離する。

```text
automation-runtime-role

paypay-worker-role

future-web-role
```

IAM Role の共有を前提としない。Least Privilege を適用する。

## Consequences

- Application ごとに必要な権限だけを与えられる。
- 新しい Application の追加時には Role を新設する運用になる。
- Secret 分離（ADR-0013）と対になり、アクセス境界を IAM と Secret の両面で分離する。

## Alternatives considered

- すべての Application で IAM Role を共有する: §51 で明示的に禁止されている。
