# 0003. ヘキサゴナルアーキテクチャを採用する（必須）

- Status: Accepted
- Date: 2026-10-03

## Context

原典: 旧設計書 §3・§11・§13（遡及記録）

Monorepo と Multiple Applications を前提としたうえで、Lambda・Playwright・EC2・Android Emulator・Appium といった技術選択を Application Core から切り離す必要があった。アーキテクチャ方針として Monorepo + Multiple Applications + Hexagonal Architecture + Independent Deployment Units を採用し、そのうちヘキサゴナルアーキテクチャは必須要件とする。

## Decision

すべての Business Application でヘキサゴナルアーキテクチャを採用する。

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

依存方向は Application Core へ向ける。外部システム・Framework への依存は Adapter へ閉じ込める（例: MoneyForwardPort ← PlaywrightMoneyForwardAdapter）。初期の MoneyForward Suite Job は、apps/automation 内部に限定した方針として Modular Monolith + Single Lambda とする（ADR-0009）。

## Consequences

- Application Core が技術選択から独立し、Adapter の差し替えが可能になる。
- Port / Adapter の境界設計が実装品質を左右するため、Port の粒度（ADR-0007）と依存方向の検証（ADR-0022）を別途規律する。
- 将来の PayPay 等も同じ構造で追加できる（PayPay の実装方式は現時点では要求として固定しない）。

## Alternatives considered

原典（旧設計書）に代替案の記録はない。§3 は「ヘキサゴナルアーキテクチャは必須要件とする」とだけ述べ、他のアーキテクチャスタイルとの比較は記録されていない。
