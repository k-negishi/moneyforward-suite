# 0027. 初期 Job を refresh-accounts（金融機関の一括更新と Suica 更新）とする

- Status: Superseded by ADR-0028
- Date: 2026-10-03

## Context

初期 Job は `refresh-suica`（モバイル Suica 単体の更新）とする計画だった。実機検証（PoC）で、ユーザーが Web 版 MoneyForward ME 上で手動実行している操作は「金融機関のデータ一括更新 → モバイル Suica の更新」という一連の流れであることを確認した。この一連の操作をそのまま 1 job として再現する方針に変わり、Job の名前とスコープを実態に合わせる必要が生じた。

決める必要があったのは、Job の名前とスコープ、2 つの処理の実行順序、認証要求（セッション失効）時の挙動、一括更新が部分的に失敗した場合（一部の金融機関のみ失敗）の挙動である。

ADR-0009（Single Lambda + Job Router）の Decision 自体は変更しない。同 ADR の例示（`refresh-suica`）が古くなるだけであり、ADR は決定時点の記録として書き換えない。

## Decision

初期 Job を `refresh-accounts` とする（Use Case 名: `RefreshAccountsUseCase`）。1 つの job で次の 2 段階をこの順に実行する。

1. 金融機関のデータ一括更新（MoneyForward ME の一括更新）
2. モバイル Suica の更新

認証要求（セッション失効）を検知した場合は、一括更新と Suica 更新の両方を停止する（Fail Closed。ADR-0012・ADR-0015）。一括更新が部分的に失敗した場合は Suica 更新を続行し、結果を合成して部分成功として表現する。

## Consequences

- ユーザーの手動操作（一括更新 → Suica 更新）をそのまま 1 job として再現でき、Job 名とスコープが実態に一致する。
- Job Router の Allow List と Composition Root の配線は `refresh-accounts` / `RefreshAccountsUseCase` で実装する。
- 2 段階が 1 実行に結合されるため、一括更新だけ・Suica 更新だけを job として実行することはできない。片方だけを実行したくなった場合は job の分割を再検討する。
- 結果は成功・部分成功・失敗の 3 態様になる。部分成功の表現方法（Application Result）と、部分成功時に Retry（ADR-0021）をどう扱うかは実装時に整理が必要（フォローアップ）。
- ADR-0009 の例示（`refresh-suica`）と ADR-0008 の例示（`RefreshSuicaUseCase`）は決定時点の記録として残り、書き換えない。

## Alternatives considered

- Job を 2 つに分割する（一括更新の job と Suica 更新の job）: ユーザーの手動操作は一連の流れであり、分けると実行順序と部分失敗時の扱いが呼び出し側（Scheduler・Job Router）へ漏れて手動操作の再現にならないため却下。
- Suica 更新を先に実行する: ユーザーが手動で行っている順序（一括更新 → Suica 更新）と逆になり、1 job として再現する目的に反するため却下。
- 一括更新が 1 つでも失敗したら全停止する（Fail Fast）: 一部の金融機関の失敗は Suica 更新の成否と独立であり、Suica 更新まで行わないのは手動操作より過剰に保守的で、利用者の期待（Suica の更新）を損なうため却下。停止するのは認証要求（セッション失効）の場合に限る。
- 部分失敗も失敗として扱う: Suica 更新まで成功している場合に全体を失敗と報告すると実際の状態と一致せず、再実行の判断を誤らせるため却下。部分成功として、何が失敗したかを表現する。
