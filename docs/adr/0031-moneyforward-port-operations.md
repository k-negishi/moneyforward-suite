# 0031. MoneyForwardPort の操作を verifySession と refreshAccounts の 2 つに絞る

- Status: Accepted
- Date: 2026-10-03

## Context

Application Core は Runtime / Framework 非依存で（ADR-0006）、MoneyForward ME の操作は Playwright Adapter へ閉じ込める（ADR-0018）。Port は外部 Capability 単位で定義し、技術細部へ分割しない（ADR-0007）。初期 Job は金融機関のデータ一括更新（ADR-0029）で、認証は手動ログインのセッション再利用とし、失効時は AUTH_REQUIRED で停止する（ADR-0012）。

決める必要があったのは、MoneyForwardPort にどの操作を載せるかである。セッション検証を一括更新と同じメソッドにするか分けるか、UI 手順（ページ遷移・クリック・待機・受付確認）をどこまで Port に出すか、認証要求と更新の拒否をどう区別するかを決めた。

## Decision

MoneyForwardPort は次の 2 メソッドだけを持つ。

- `verifySession(session): Promise<SessionVerification>` — セッションの有効性を `VALID | AUTH_REQUIRED | UNKNOWN` の三値で返す
- `refreshAccounts(session): Promise<Result<RefreshAccountsOutcome>>` — 金融機関のデータ一括更新を実行し、受付・結果の観測値（件数と真偽値のみ）を返す

操作の単位は外部 Capability（セッション検証・一括更新）とし、UI 手順（対象の特定・クリック・ポーリング・受付確認）は Adapter の内部に置く。

戻り値の形は操作の性質に合わせて分ける。`verifySession` は「有効 / 認証要求 / 判定不能」の三値で十分で、Domain Error の分類（再試行可否等）を持ち込む理由がないため三値にする。`refreshAccounts` の `Result.error` は操作そのものが成立しなかった場合（認証要求・セッション不正・対象特定不能・一時障害等）に限る。受付が確認できなかった場合は操作として成立し `ok: true` の観測結果を返し、`acceptance = NOT_ACCEPTED` と観測の根拠（`evidence`）で表す。

## Consequences

- セッション検証だけを行いたい呼び出し（実行前の事前チェック、CLI、Job Router）が、一括更新の副作用なしに検証できる。
- Playwright の型（Page / Locator 等）が Port の型に現れず、UI 手順の変更は Adapter 内で完結する。
- 受付確認のポーリング方法（変化の検出・タイムアウト・失敗文言の判定）は Adapter の実装詳細になり、Core は観測値（件数・真偽値）だけを見る。
- 認証要求は `verifySession` でも `refreshAccounts` の `Result.error`（AUTH_REQUIRED）でも検知でき、どちらも呼び出し側が fail closed で停止する。
- 個別口座の更新など 2 メソッドで足りない操作が必要になった場合は、外部 Capability の単位で追加を再判断する。

## Alternatives considered

- 単一メソッド（`refreshAccounts` だけにして認証検証も兼ねる）: 検証だけを行いたい呼び出しが一括更新を実行してしまう。また、認証要求（再ログインが要る）と更新の拒否（操作は成立したが受け付けられない）の区別が戻り値で曖昧になり、再試行判断（ADR-0021）ができないため却下。
- UI 手順の単位で分割する（`openAccounts` / `clickBulkUpdate` / `observeResult` 等）: 技術細部の Port（ADR-0007 の禁止例）になり、Adapter の実装変更が Core の契約変更へ波及するため却下。
- `verifySession` も `Result` で返す: 三値以上の情報がなく、検証に Domain Error の分類（retryable・再試行語彙）を持ち込む必要がないため却下。
- 受付確認を Core 側で行う（`refreshAccounts` はクリックまでとし、Core が状態確認を繰り返す）: 状態確認は UI 操作であり、Playwright の型と手順が Core へ漏れるため却下（ADR-0018）。
