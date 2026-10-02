# 0005. パッケージ管理に pnpm workspace を採用する

- Status: Accepted
- Date: 2026-10-03

## Context

原典: 旧設計書 §5・§6（遡及記録）

モノレポで複数の Application と共有 package を管理するため、Workspace の範囲と Package Manager を決める必要があった。初期構成は apps/automation と packages/core・adapter-moneyforward-playwright・adapter-aws・security・contracts、infra/automation を基本とし、将来は apps/paypay-worker・apps/web 等へ拡張できることとする。

## Decision

Package Manager に pnpm を採用し、pnpm workspace で apps/* と packages/* を対象とする。

```yaml
packages:
  - apps/*
  - packages/*
```

各 Application は必要な workspace package だけに依存する。将来用の Directory や Package を現時点で空作成する必要はない。

## Consequences

- 依存関係が Application ごとに閉じ、Runtime 固有 Dependency の混入を防ぎやすくなる。
- 将来の Application / package 追加は workspace の規約に沿って行う。
- 将来構成の図（§5）は目標であり現行構造ではない。現在の構造は architecture 文書に示す。

## Alternatives considered

原典（旧設計書）に代替案の記録はない。Package Manager は「pnpm を第一候補とする」とされており、比較した他の候補は明記されていない。
