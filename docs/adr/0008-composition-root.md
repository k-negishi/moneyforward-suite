# 0008. Composition Root で依存を注入する

- Status: Accepted
- Date: 2026-10-03

## Context

原典: 旧設計書 §15（遡及記録）

Concrete Adapter（PlaywrightMoneyForwardAdapter・AwsSecretsManagerAdapter 等）をどこで生成し、Use Case へどう注入するかを決める必要があった。Core 内で生成すると、Core が Adapter 実装へ依存してしまう。

## Decision

Concrete Adapter の生成および Port への注入は、各 Application の Composition Root で行う（例: apps/automation/composition-root.ts）。

```typescript
const moneyForward =
  new PlaywrightMoneyForwardAdapter(...);

const secrets =
  new AwsSecretsManagerAdapter(...);

const useCase =
  new RefreshSuicaUseCase(
    moneyForward,
    secrets,
  );
```

Application Core 内で Concrete Adapter を直接生成しない。

## Consequences

- Core は Port にのみ依存し、Adapter の差し替え（実サービスを使わないテスト等）が可能になる。
- 依存の組み立ては Application のエントリ側に集約され、Runtime ごとの構成を Composition Root で表現できる。
- Application 間で Concrete Adapter を直接共有しない（§51）ため、共有は Port を通じて行う。

## Alternatives considered

原典（旧設計書）に代替案の記録はない。
