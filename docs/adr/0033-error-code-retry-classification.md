# 0033. ErrorCode の語彙と再試行可否を 1 つの対応表で定義する

- Status: Proposed
- Date: 2026-10-03

## Context

Retry は一時障害のみを対象に初回込み最大 3 試行とし、再試行可否の判定が実装上の論点になる（ADR-0021）。初期 Job では認証要求（セッション失効）を検知したら停止し、一括更新の受付・結果を行の変化で判定する（ADR-0028・ADR-0029）。Secret の取得失敗（欠如・破損・権限不足）は区別して fail closed で扱う（ADR-0011・ADR-0013）。また、エラーに自由文字列の message を持たせると Secret・金融情報の混入経路になり、ログの Allow List も破る（ADR-0016）。

決める必要があったのは、エラー分類の語彙をどこまで区別するか、再試行可否をどう表現するか、受付の拒否と受付確認の不能をどう区別するかである。

## Decision

エラー分類 `ErrorCode` の語彙を次のとおり定義し、すべてのエラーをこの分類に閉じる。message 等の自由文字列は持たない。

```text
AUTH_REQUIRED
SESSION_MISSING
SESSION_INVALID
INVALID_JOB
TARGET_NOT_FOUND
TARGET_AMBIGUOUS
REFRESH_REJECTED
REFRESH_NOT_ACCEPTED
TEMPORARY_FAILURE
SECRET_NOT_FOUND
SECRET_INVALID
ACCESS_DENIED
UNKNOWN
```

再試行可否は分類から一意に決まる対応表で定義する。再試行可能（`retryable = true`）は `TEMPORARY_FAILURE` / `REFRESH_NOT_ACCEPTED` / `UNKNOWN` の 3 つだけとし、他は再試行しない。認証（再ログインというユーザー操作が要る）・Secret（構成の問題）・対象特定（対象が無い・曖昧）・明示的な拒否は、再試行しても回復しないため対象外とする。

`REFRESH_REJECTED` と `REFRESH_NOT_ACCEPTED` は分ける。前者は MoneyForward 側が明示的に拒否・失敗した観測（失敗の出現）がある場合で、再試行しない。後者は受付の確認ができなかった（失敗の観測がない）場合で、一時障害の可能性があるため再試行する。一括更新の受付が確認できない場合の呼び分けはこの 2 つで行う。

`SECRET_NOT_FOUND` / `SECRET_INVALID` / `ACCESS_DENIED` は Secret Store Adapter が区別する取得失敗の語彙と一致させ、Adapter の実装がこの分類へ写像する。

## Consequences

- 呼び出し側（Use Case・Job Router・実行基盤）は `DomainError.retryable` で再試行判断を一意にできる（ADR-0021 の「一時障害のみ Retry」に対応）。
- 語彙が 1 つの union 型になり、追加は型の変更になる。再試行可否の対応表を `Record<ErrorCode, boolean>` でテストするため、語彙の追加時に分類漏れが型検査で検出される。
- `UNKNOWN` を再試行可能にするのは、判定不能（タイムアウト・本文取得失敗等）が一時障害である可能性を許すためである。判定不能を成功と見なさず再試行に回す（fail closed）。
- 部分成功（一部の行の失敗）は Application Result の status で表現し、errorCode を付けない。部分失敗を再試行の対象にするかは Use Case 側のフォローアップとする（ADR-0028 が整理を残している）。
- エラーの内容を文字列で伝えられないため、調査は errorCode と観測値（件数等）で行う。ログも Allow List（ADR-0016）のままになる。

## Alternatives considered

- `REFRESH_REJECTED` と `REFRESH_NOT_ACCEPTED` を統合する: 再試行可否が分かれず、回復しない拒否を再試行して試行回数を消費するか、回復し得る受付確認不能を再試行しないかの誤りが生じるため却下。
- エラーに自由文字列の message を持たせる: Secret・金融情報の混入経路になり、ログの Allow List を破るため却下。
- 汎用の `UNKNOWN` だけにする: 認証要求（ユーザー操作が要る）と一時障害（再試行で回復し得る）を切り分けられず、再試行判断と運用ができないため却下。
- 再試行可否を status から導出する: status は Application の終状態であり、部分成功のように status だけでは再試行判断が決まらない状態がある。失敗の分類（errorCode）から導出する方が一意になるため却下。
- 再試行可否をエラー生成側（Adapter・Use Case）が個別に指定する: 同じ分類でも実装ごとに可否がぶれ、判断基準が分散するため却下。対応表を 1 箇所に固定する。
