# 0033. ErrorCode の語彙と再試行可否を 1 つの対応表で定義する

- Status: Proposed
- Date: 2026-10-03

## Context

Retry は一時障害のみを対象に初回込み最大 3 試行とし、再試行可否の判定が実装上の論点になる（ADR-0021）。初期 Job では認証要求（セッション失効）を検知したら停止し、一括更新の受付・結果を行の変化で判定する（ADR-0028・ADR-0029）。Secret の取得失敗（欠如・破損・権限不足）は区別して fail closed で扱う（ADR-0011・ADR-0013）。また、エラーに自由文字列の message を持たせると Secret・金融情報の混入経路になり、ログの Allow List も破る（ADR-0016）。

決める必要があったのは、エラー分類の語彙をどこまで区別するか、再試行可否をどう表現するか、受付の拒否と受付確認の不能をどう区別するかである。また、分類と再試行可否の対応が実装箇所ごとにぶれず、失敗結果の組み立てが呼び出し側へ分散しない形にする必要があった。

## Decision

エラー分類 `ErrorCode` の語彙を次のとおり定義し、すべてのエラーをこの分類に閉じる。message 等の自由文字列は持たない。語彙は job に依存しないため、エラー体系（語彙・再試行可否・Domain Error）は job 非依存のモジュールへ置く。

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

再試行可否は分類から一意に決まる対応表（1 箇所の定義）で決める。再試行可能（`retryable = true`）は `TEMPORARY_FAILURE` / `REFRESH_NOT_ACCEPTED` / `UNKNOWN` の 3 つだけとし、他は再試行しない。認証（再ログインというユーザー操作が要る）・Secret（構成の問題）・対象特定（対象が無い・曖昧）・明示的な拒否は、再試行しても回復しないため対象外とする。

Domain Error は分類（`code`）だけを運び、再試行可否は保持しない（`isRetryableErrorCode(code)` で導出する）。保持フィールドにすると `{ code: 'TEMPORARY_FAILURE', retryable: false }` のような不整合な値が構築できるため、対応表を唯一の判断源にする。Domain Error は型レベルのブランドを持ち、生成を専用の関数（`createDomainError`）に型で強制する。ブランドはファントム（実行時の形状は分類だけのまま）で、リテラルからの直接構築は型エラーになる。

語彙外の値の扱いは 1 つの正規化規則に統一する。内部の `normalizeErrorCode` が唯一の規則で、生成（`createDomainError`）と再試行可否の判断（`isRetryableErrorCode`）の両方がこれを通る。キャストで混入した語彙外の値は `UNKNOWN`（再試行可）として扱い、生の文字列がログの `errorCode` として流れる経路を断つ（fail closed）。実行時の境界で語彙を検証できるよう `isErrorCode` を公開する（正規化自体は公開しない）。

`REFRESH_REJECTED` と `REFRESH_NOT_ACCEPTED` は分ける。前者は MoneyForward 側が明示的に拒否・失敗した観測（失敗の出現）がある場合で、再試行しない。後者は受付の確認ができなかった（失敗の観測がない）場合で、一時障害の可能性があるため再試行する。一括更新の受付が確認できない場合の呼び分けはこの 2 つで行う。

`SECRET_NOT_FOUND` / `SECRET_INVALID` / `ACCESS_DENIED` は Secret Store Adapter が区別する取得失敗の語彙と一致させ、Adapter の実装がこの分類へ写像する。

Application Result は判別 union とし、`errorCode` は `FAILURE` のときだけ持つ（失敗以外にエラー分類が付かないことを型で表す）。Domain Error から失敗の Application Result への写像は正準の関数（1 つの入口）を用意し、呼び出し側が失敗結果を手組みしないようにする。

`SUCCESS` は「受付が確認でき、失敗の観測がない」ことを表す。更新の完了確認ではなく、進行中シグナルの出現だけでも受付の確認として成功とする（完了を待つと待機時間とタイムアウトの設計が Adapter の都合へ引きずられるため、完了確認は行わない）。

## Consequences

- 呼び出し側（Use Case・Job Router・実行基盤）は `DomainError` の分類から `isRetryableErrorCode` で再試行判断を一意にできる（ADR-0021 の「一時障害のみ Retry」に対応）。
- 対応表が 1 箇所になり、語彙の追加時は `Record<ErrorCode, boolean>` のテストが分類漏れを型検査で検出する。
- 不整合な Domain Error（分類と再試行可否の食い違い）が構築できない。ブランドにより生成が `createDomainError` に型で強制され、キャスト混入した語彙外の値は実行時の正規化で `UNKNOWN`（再試行可）に落ちる。生成と再試行可否の判断は同じ規則を通るため、同じ値で判断が分かれない。
- 失敗結果の組み立てが正準の写像に集約され、`errorCode` を付け忘れる・別の分類を手で入れる実装が現れない。
- `UNKNOWN` を再試行可能にするのは、判定不能（タイムアウト・本文取得失敗等）が一時障害である可能性を許すためである。判定不能を成功と見なさず再試行に回す（fail closed）。
- `SUCCESS` が受付確認までを指すため、実更新の完了を前提にする呼び出し側の処理（完了待ち・件数確認等）は別途設計が必要になる。
- 部分成功（一部の行の失敗）は status で表現し、errorCode を付けない。部分失敗を再試行の対象にするかは Use Case 側のフォローアップとする（ADR-0028 が整理を残している）。
- エラーの内容を文字列で伝えられないため、調査は errorCode と観測値（件数等）で行う。ログも Allow List（ADR-0016）のままになる。
- 語彙と対応表は job 非依存のモジュールへ置かれ、将来の Use Case（PayPay 等）も同じ語彙を共有する。Use Case 固有の分類が必要になった場合は語彙の追加として判断する。

## Alternatives considered

- `REFRESH_REJECTED` と `REFRESH_NOT_ACCEPTED` を統合する: 再試行可否が分かれず、回復しない拒否を再試行して試行回数を消費するか、回復し得る受付確認不能を再試行しないかの誤りが生じるため却下。
- エラーに自由文字列の message を持たせる: Secret・金融情報の混入経路になり、ログの Allow List を破るため却下。
- 汎用の `UNKNOWN` だけにする: 認証要求（ユーザー操作が要る）と一時障害（再試行で回復し得る）を切り分けられず、再試行判断と運用ができないため却下。
- 再試行可否を status から導出する: status は Application の終状態であり、部分成功のように status だけでは再試行判断が決まらない状態がある。失敗の分類（errorCode）から導出する方が一意になるため却下。
- 再試行可否をエラー生成側（Adapter・Use Case）が個別に指定する: 同じ分類でも実装ごとに可否がぶれ、判断基準が分散するため却下。対応表を 1 箇所に固定する。
- Domain Error に `retryable` を保持フィールドとして持たせる: 分類と矛盾する値（`TEMPORARY_FAILURE` で `retryable = false`）を構築でき、判断源が 2 つになるため却下。分類から導出する。
- Application Result を「`status` と optional な `errorCode`」の 1 つの型にする: `SUCCESS` に `errorCode` を付けられる形が残り、「失敗のときだけ分類を持つ」不変条件を型で表せないため却下。判別 union にする。
- Domain Error をブランドなしの構造的な型（`{ code: ErrorCode }`）にする: リテラルから自由に構築でき、生成経路（語彙の検証・正規化）を通らない値が型検査をすり抜けるため却下。ファントムのブランドで生成を `createDomainError` に強制する。
- 語彙外の値の正規化を経路ごとに変える（生成は `UNKNOWN`、再試行可否の判断は `false`）: 同じ値で「再試行可」と「再試行不可」の判断が反転し、呼び出し側が誤るため却下。規則を 1 つに統一し、どちらの経路も `UNKNOWN`（再試行可）に揃える。
- キャストで混入した語彙外の値をそのまま通す: 生の文字列がログの `errorCode` として流れ、Allow List（ADR-0016）を破り得るため却下。実行時に語彙の集合で検証し `UNKNOWN` へ丸める。
