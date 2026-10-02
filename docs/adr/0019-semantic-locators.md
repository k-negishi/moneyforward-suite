# 0019. Locator は意味ベースで選択する

- Status: Accepted
- Date: 2026-10-03

## Context

原典: 旧設計書 §21（遡及記録）

MoneyForward Adapter の自動操作は、画面構造の変更で壊れやすい。位置依存の Selector を避け、選択方法の優先順位を決める必要があった。

## Decision

MoneyForward Adapter では位置依存 Selector を原則使用せず、次の優先順位で Locator を選ぶ。

1. role
2. accessible name
3. visible text
4. stable attribute
5. CSS selector

以下のような位置依存の指定を禁止する。

```text
3番目の更新ボタン
:nth-child(...)
```

## Consequences

- 画面の並び替えに強い自動操作になる。
- CSS selector は最後の手段であり、採用時には理由が問われる。
- どの優先順位で取れなかった場合の扱いは実装時のレビュー観点になる。

## Alternatives considered

- 位置依存 Selector（3 番目の更新ボタン・:nth-child 等）: §21 で禁止例として明示されている。
