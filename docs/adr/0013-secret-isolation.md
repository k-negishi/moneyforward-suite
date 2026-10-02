# 0013. Secret を Application 単位で分離する

- Status: Accepted
- Date: 2026-10-03

## Context

原典: 旧設計書 §29・§30（遡及記録）

モノレポでは Secret も同一 Repository に集まりやすい。将来 automation（MoneyForward Session）と paypay-worker（PayPay 関連 Secret）が並ぶことを想定すると、Secret アクセスの境界を決める必要があった。Same Repository ≠ Shared Secrets。

## Decision

Application ごとに Secret Access を分離し、不要な相互アクセスを許可しない。

```text
automation
→ MoneyForward Session

paypay-worker
→ PayPay関連Secret
```

PayPay Worker が追加されても PayPay Credential を Automation Lambda へ渡さない。MoneyForward Session が不要な Application には MoneyForward Session を渡さない。

## Consequences

- Secret の漏えい経路が Application 境界で限定される。
- Secret 取得の権限（IAM）も Application 単位で設計する（ADR-0014）。
- Secret の値をログ・Artifact へ出さない制約（ADR-0016・ADR-0017）と併せて機能する。

## Alternatives considered

- Secret を Repository 全体で共有する: §30 の「Same Repository ≠ Shared Secrets」で否定されている。
