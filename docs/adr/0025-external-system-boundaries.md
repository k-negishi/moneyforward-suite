# 0025. 外部システム境界を Adapter で分離する（MoneyForward と PayPay）

- Status: Accepted
- Date: 2026-10-03

## Context

原典: 旧設計書 §45（遡及記録）

将来 PayPay 取り込みを実装する場合、PayPay UI 操作と MoneyForward 反映の両方を扱う。1 つの巨大 Adapter へ混在させると、責務と変更理由が混ざる。

## Decision

PayPay UI 操作と MoneyForward 反映を 1 つの Adapter へ混在させない。外部システム境界を Adapter で分離する。

```text
PayPayPort
     ↑
PayPay Adapter

MoneyForwardPort
     ↑
MoneyForward Adapter
```

Application Use Case が両 Port をオーケストレーションする。

## Consequences

- 各 Adapter は 1 つの外部システムだけを扱い、独立して変更・テストできる。
- 両者を組み合わせる処理（PayPay の情報を MoneyForward へ反映する等）は Application 層の Use Case に置かれる。
- PayPay の実装方式は現時点では要求として固定しない（ADR-0004・requirements.md）。

## Alternatives considered

- PayPay UI 操作と MoneyForward 反映を 1 つの巨大 Adapter へ混ぜる: §45 で否定されている。
