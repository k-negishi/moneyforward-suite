# 0015. 認証チャレンジを自動回避しない

- Status: Accepted
- Date: 2026-10-03

## Context

原典: 旧設計書 §32（遡及記録）

自動操作中にサービス側の Security Challenge が発生し得る。回避を試みるとサービス側の防御を破る実装になり得るため、挙動を決める必要があった。

## Decision

以下を自動回避しない。

- CAPTCHA
- OTP
- 追加本人確認
- 新端末確認
- その他サービス側の Security Challenge

必要な場合は安全に停止する。

## Consequences

- チャレンジ検知時は自動実行が停止し、ユーザー対応が必要になる。
- 停止は Fail Closed（ADR-0011）の具体化であり、検知時の状態（AUTH_REQUIRED 等）は認証の扱い（ADR-0012）に従う。

## Alternatives considered

- CAPTCHA 等の Security Challenge を自動回避する: §51 で明示的に禁止されている。
