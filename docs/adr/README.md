# Architecture Decision Records（ADR）

このディレクトリは、このリポジトリの設計判断の記録（ADR）を置く場所である。

## ADR とは

- 1 つの設計判断を 1 ファイルに記録する。決定時点の内容を保持し、承認後は書き換えない。
- 「何を決めたか」だけでなく「なぜ決めたか」「何を却下したか」を残す。
- 現在の構造の説明や要件は ADR ではない。ADR は決定の履歴であり、現在の姿は別の文書（アーキテクチャ文書・要件文書）が示す。

## 運用規約

| 項目 | 規約 |
|---|---|
| 書式 | MADR 簡略版（`template.md`）。Status / Date / Context / Decision / Consequences / Alternatives considered |
| Status | `Proposed` / `Accepted` / `Deprecated` / `Superseded by ADR-NNNN` の 4 種 |
| ファイル名 | `NNNN-slug.md`（4 桁ゼロ埋め連番）。番号は不変で、欠番を再利用しない |
| 粒度 | 1 決定 1 ファイル |
| 変更 | 承認後の ADR は書き換えない。決定を変えるときは新しい ADR を作り、旧 ADR の Status を `Superseded by ADR-NNNN` にする（本文は履歴として残す） |
| 遡及記録 | 旧設計書から移行する ADR は retrospective として、Date に原典の日付（2026-10-03）を記す |

## 決定一覧

| # | タイトル | Status | Date |
|---|---|---|---|
| [0001](0001-adopt-adr.md) | 設計判断の記録に ADR を採用する | Accepted | 2026-10-03 |

ADR-0002〜0025（旧設計書からの遡及記録）は #21 の移行で追加する。
