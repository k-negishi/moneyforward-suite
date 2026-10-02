# 0023. CI/CD をモノレポ対応（affected build）にする

- Status: Accepted
- Date: 2026-10-03

## Context

原典: 旧設計書 §37・§38・§39（遡及記録）

モノレポでは 1 つの変更が特定の Application にのみ影響する。変更のたびに全体を Build / Deploy すると無駄が大きく、逆に検証の不足も避けたい。CI/CD の実行範囲を決める必要があった。

## Decision

CI/CD もモノレポ対応とし、「変更された Application + 影響を受ける Shared Package」に応じて必要な Build / Test を行う。

```text
apps/automation changed
        ↓
Automation Test
        ↓
Automation Image Build
        ↓
Lambda Deploy
```

apps/paypay-worker の変更だけで Automation Lambda を Deploy する必要はない構成を目指す。packages/core 等の共有 Package を変更した場合は、それを利用する Application すべてについて Test を実行する。Turborepo・Nx 等の affected build 機構は必要に応じて導入でき、MVP 時点では必須としない。

## Consequences

- 変更範囲に応じた CI/CD になり、Deploy の影響範囲が小さくなる。
- 「影響を受ける」範囲の判定（依存グラフ）を維持する必要がある。
- 将来 Application が増えても Pipeline を追加するだけで拡張できる（ADR-0004）。

## Alternatives considered

- Turborepo / Nx 等の affected build 機構: 将来必要に応じて導入できる候補として挙げられ、MVP では必須としないとされている。
