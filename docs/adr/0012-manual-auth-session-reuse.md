# 0012. 認証は手動ログインとセッション再利用で行う

- Status: Accepted
- Date: 2026-10-03

## Context

原典: 旧設計書 §27（遡及記録）

MoneyForward ME の操作には認証済みセッションが必要になる。MVP で認証をどう扱うかを決める必要があった。

## Decision

MVP では MoneyForward ID / Password による自動ログインを実装しない。ローカル環境でユーザーが手動ログインし、認証セッションを生成して再利用する。セッション失効時は AUTH_REQUIRED として停止する。

## Consequences

- Password 等の認証情報をシステムが保持・入力する必要がない。
- セッション失効時は自動復旧せず、ユーザー操作（再ログイン）が必要になる。
- セッションの保存・取り扱いは Secret 分離（ADR-0013）とログ制約（ADR-0016）に従う。

## Alternatives considered

- MoneyForward ID / Password による自動ログイン: MVP では実装しないと明記されている。
