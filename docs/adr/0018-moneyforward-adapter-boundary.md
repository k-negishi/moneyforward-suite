# 0018. MoneyForward Adapter の境界を閉じる（Playwright を Core へ漏らさない）

- Status: Accepted
- Date: 2026-10-03

## Context

原典: 旧設計書 §20（遡及記録）

MoneyForward ME Web 版の操作には Playwright を使う。Playwright の型（Page / Locator / Browser / BrowserContext）を Core へ漏らすと、Core がブラウザ実装へ依存してしまう。

## Decision

MoneyForward ME Web 版の操作は Playwright Adapter へ閉じ込める。Application Core へ以下を漏らさない。

```text
Page
Locator
Browser
BrowserContext
```

Playwright を Core へ依存させない。

## Consequences

- Core は Playwright を知らず、Adapter の差し替えが可能になる。
- Adapter 内部では Locator 等を扱うが、Port の型には UI 詳細を出さない（ADR-0007）。
- 漏えいは Architecture Test（ADR-0022）で検出する。

## Alternatives considered

- Playwright を Core へ依存させる: §51 で明示的に禁止されている。
