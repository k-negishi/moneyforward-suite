# 0016. ログを Allow List 方式にする

- Status: Accepted
- Date: 2026-10-03

## Context

原典: 旧設計書 §33（遡及記録）

金融サービスを自動操作すると、ログに Secret や金融情報が混入し得る。ログへ何を出すかを決める必要があった。

## Decision

ログは Allow List 方式とし、基本的に以下のみ記録する。

```text
timestamp
application
job
status
attempt
durationMs
errorCode
```

以下をログへ出力しない。

```text
Password
Cookie
Session Token
storageState
金融明細
カード情報
HTML
DOM
```

## Consequences

- 出力できる field が列挙に限定され、自由文字列をそのまま出せない。
- デバッグ時に HTML / DOM 等が必要になっても、ログではなくローカル開発時の限定的な手段（ADR-0017）に頼ることになる。

## Alternatives considered

原典（旧設計書）に代替案の記録はない。
