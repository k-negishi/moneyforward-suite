# 0022. Architecture Test で境界を検証する

- Status: Accepted
- Date: 2026-10-03

## Context

原典: 旧設計書 §35（遡及記録）

Core の非依存（ADR-0006）や Application 間の分離（ADR-0004）は、規約だけでは守られない。CI で機械的に検証する必要があった。

## Decision

CI で Architecture Boundary を検証する。最低限、以下を禁止する。

```text
core → playwright

core → aws-sdk

core → appium

core → android

core → lambda

core → ec2
```

また、以下に代表される Application 間の不適切な Runtime 依存も禁止する。

```text
apps/automation
→ paypay-worker implementation
```

## Consequences

- 依存境界の違反が CI で検出され、レビュー以前に防げる。
- 境界の追加・変更時は Architecture Test の更新が必要になる。
- 検証方法はリポジトリのビルドで実行できる仕組み（import 関係の検査等）を選ぶ。

## Alternatives considered

原典（旧設計書）に代替案の記録はない。
