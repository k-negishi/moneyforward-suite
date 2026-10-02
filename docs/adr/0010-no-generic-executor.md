# 0010. 汎用 Executor を禁止する（外部入力による任意操作の排除）

- Status: Accepted
- Date: 2026-10-03

## Context

原典: 旧設計書 §18（遡及記録）

Job Router（ADR-0009）は外部入力で Job を選択する。入力の自由度を許すと、金融サービスに対する任意操作の実行口になる。入力から実行内容を指定できる設計を禁止する必要があった。

## Decision

外部入力から任意操作を指定できる設計を禁止する。次のような入力を受け付けてはならない。

```json
{
  "url": "...",
  "selector": "...",
  "action": "click"
}
```

外部から自由に実行できてはならないもの: 任意 URL・任意 Selector・任意 JavaScript・任意 Shell Command・任意 Playwright 処理・任意 Appium 処理。汎用 Automation Executor を作らない。

## Consequences

- 実行可能な処理はコード上の Allow List（Job Router の switch）に固定される。
- 入力の追加時は「任意操作を指定できてしまわないか」がレビュー観点になる。

## Alternatives considered

- url・selector・action を入力に取る汎用 Executor: §18 で禁止例として明示されている。
