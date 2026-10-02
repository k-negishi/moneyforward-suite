# 0011. Security Policy を機能要件より優先する（Fail Closed 等）

- Status: Accepted
- Date: 2026-10-03

## Context

原典: 旧設計書 §28・§51（遡及記録）

金融関連サービスを扱うため、セキュリティ要件を機能要件より優先することを基本方針とする必要があった。基本原則は Fail Closed・Least Privilege・Secret Isolation・Minimal Logging・Runtime Isolation。MUST NOT として、TLS 検証を無効化しないこと等が挙げられている。

## Decision

セキュリティ要件を機能要件より優先し、以下の基本原則を適用する。

```text
Fail Closed
Least Privilege
Secret Isolation
Minimal Logging
Runtime Isolation
```

TLS 検証を無効化しない。Secret・金融情報をログ出力しない。Fail Closed とし、欠如・破損・失効を区別して安全側に停止する。

## Consequences

- 判断に迷う場合は機能を止める側（Fail Closed）に倒す。
- 個別の原則は Secret 分離（ADR-0013）・IAM（ADR-0014）・認証チャレンジ（ADR-0015）・ログ（ADR-0016）・Production Artifact（ADR-0017）等の ADR に展開される。
- 例外（TLS 検証の無効化等）を許さないため、デバッグ手順にも制約が及ぶ。

## Alternatives considered

- TLS 検証を無効化する: §51 で明示的に禁止されている。
