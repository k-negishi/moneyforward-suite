# 0009. 初期 Automation は Single Lambda + Job Router で構成する

- Status: Accepted
- Date: 2026-10-03

## Context

原典: 旧設計書 §16・§17（遡及記録）

初期段階で MoneyForward 関連 Job をどう実行するかを決める必要があった。Job を追加するたびに Lambda Function を増やす構成は管理対象を不必要に増やす。また Lambda への入力によって Job を選択する仕組みでは、入力の扱いを受限制にする必要がある（ADR-0010）。

## Decision

初期 Automation を次の構成とする。

```text
apps/automation
       ↓
Single Lambda
       ↓
Job Router
       ↓
Use Cases
```

Job Router は Lambda への入力の job フィールドで Job を選択する Allow List 方式とする（例: `{"job": "refresh-suica"}`）。未知の Job は InvalidJobError として拒否する。

```typescript
switch (event.job) {
  case "refresh-suica":
    return executeRefreshSuica();

  default:
    throw new InvalidJobError();
}
```

この Single Lambda 方針は apps/automation 内部に限定した方針であり、Repository 全体の制約ではない（ADR-0004）。

## Consequences

- MoneyForward 関連 Job を追加しても Lambda Function は増えない。
- 実行できる Job はコードに列挙されたものに限られ、外部入力で任意の処理を選べない（ADR-0010）。
- Job 追加時は Job Router の Allow List の更新が必要になる。

## Alternatives considered

- Job ごとに Lambda Function を増やす構成: 原典は「増やす必要はない」として Single Lambda + Job Router を採用している。
