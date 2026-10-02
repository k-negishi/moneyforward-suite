# 0007. Port は外部 Capability 単位で定義する（過剰抽象化の禁止）

- Status: Accepted
- Date: 2026-10-03

## Context

原典: 旧設計書 §14（遡及記録）

ヘキサゴナルアーキテクチャは必須だが、Port を技術の細部に合わせて分割すると、かえって Core が技術へ引きずられる。Port の粒度を決める必要があった。

## Decision

Port は外部 Capability 単位で定義し、過剰な抽象化を禁止する。

定義する Port の例:

```text
MoneyForwardPort
SecretStorePort
LoggerPort
将来: PayPayPort
```

以下のような技術細部の Port は作らない。

```text
BrowserPort
PagePort
ButtonPort
ClickPort
SelectorPort
```

## Consequences

- Core の Port は外部システムの能力を表し、Playwright 等の UI 詳細が型・インターフェースへ出ない（ADR-0018）。
- Port の追加時には「外部 Capability か、技術の細部か」がレビュー観点になる。

## Alternatives considered

- BrowserPort / PagePort / ButtonPort / ClickPort / SelectorPort のような細分化: §14 で禁止例として明示されている。
