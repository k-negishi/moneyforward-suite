# 0020. 成功判定は状態変化で行う

- Status: Accepted
- Date: 2026-10-03

## Context

原典: 旧設計書 §22（遡及記録）

更新操作は「クリックできた」ことと「更新された」ことが別である。成功判定の基準を決める必要があった。

## Decision

更新ボタンのクリック成功だけで SUCCESS としない。最低限、次の流れを確認する。

```text
更新要求
 ↓
MoneyForward側で受付
 ↓
状態変化
```

## Consequences

- 成功は外部システムの状態変化で判定され、実行結果の信頼性が上がる。
- 状態確認の方法は MoneyForward Adapter 内に閉じる（ADR-0018）。
- 判定の操作は Locator 方針（ADR-0019）に従う。

## Alternatives considered

- 更新ボタンのクリック成功のみで SUCCESS とする: §22 で否定されている。
