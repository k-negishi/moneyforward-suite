# 0021. Retry と実行基盤（Step Functions・Lambda Timeout）

- Status: Accepted
- Date: 2026-10-03

## Context

原典: 旧設計書 §24・§25・§26（遡及記録）

定期実行（要件は requirements.md）では一時障害の再試行が必要になる。一方、Lambda 内部で長時間待機してはならない。Retry の回数・間隔と、待機を担う実行基盤、Lambda の Timeout を決める必要があった。

## Decision

一時障害のみ Retry する。初回込み最大 3 試行とし、Retryable の場合は 1 時間待って再試行する。

```text
Attempt #1
     ↓
Retryable
     ↓
Wait 1 hour
     ↓
Attempt #2
     ↓
Retryable
     ↓
Wait 1 hour
     ↓
Attempt #3
```

Lambda 内部で長時間待機せず、初期構成として次の実行基盤とする。

```text
EventBridge Scheduler
        ↓
Step Functions
        ↓
Automation Lambda
```

Step Functions が 1 時間の Wait を担当する。Lambda Timeout の初期値は 5 minutes とし、通常処理は 30 seconds - 2 minutes 程度を目標とする。

## Consequences

- 再試行の待機がマネージド側に移り、Lambda は 1 回の試行に集中できる。
- 再試行を含む実行状態は Step Functions で可視化される。
- 一時障害と恒久障害の判定（Retryable か否か）が実装上の論点になる。

## Alternatives considered

- Lambda 内部で長時間待機して Retry する: §25 で禁止されている。
