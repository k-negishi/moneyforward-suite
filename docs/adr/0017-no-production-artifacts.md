# 0017. Production Artifact を恒常保存しない

- Status: Accepted
- Date: 2026-10-03

## Context

原典: 旧設計書 §34（遡及記録）

Screenshot・HTML・DOM Dump・HAR・Trace・Video には金融情報が含まれ得る。金融 Application でこれらをどう扱うかを決める必要があった。Android Automation も画面録画・Screenshot 等に金融情報が含まれる可能性があるため同様とする。

## Decision

金融 Application では以下を原則として恒常保存しない。

```text
Screenshot
HTML
DOM Dump
HAR
Trace
Video
```

ローカル開発時のみ必要最小限許可する。

## Consequences

- 失敗調査はログ（ADR-0016）と状態変化の記録を中心に行う。
- ローカルでの調査でも「必要最小限」の規律が適用される。

## Alternatives considered

原典（旧設計書）に代替案の記録はない。
