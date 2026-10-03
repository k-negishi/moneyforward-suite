# 0034. Architecture Test を自作の import 検出器で実装する

- Status: Proposed
- Date: 2026-10-03

## Context

ADR-0022 で CI による境界検証（Architecture Test）を決めたが、検証方法は「リポジトリのビルドで実行できる仕組み（import 関係の検査等）」とだけ定めており、具体手段は未決定だった。実装にあたり、次の条件を満たす手段を選ぶ必要があった。

- 依存パッケージを増やさない（Security Policy を機能要件より優先する方針のもと、供給網（Supply Chain）を広げない）
- workspace package 間の依存方向（Adapter → Core は許可、逆は禁止）・アプリケーション間 import の禁止・相対 import でのパッケージ越えの禁止という、リポジトリ固有の規則を表現できる
- Pull Request の基本 CI で実行でき、違反時は原因の import が分かる

## Decision

リポジトリ横断テスト（`tests/architecture.test.ts`・Vitest の `repo-policy` プロジェクト）に自作の純関数検出器を置き、`pnpm test:architecture` で実行する。CI では typecheck の後・全テストの前に独立ステップとして実行し、失敗工程として可視にする。

- import 指定子は字句走査で抽出する（`from '...'`・`import '...'`・`import('...')`・`require('...')`）。コメント・文字列リテラル・正規表現リテラルの中の import 風の記述は依存として数えない（誤検出で CI を止めない）。
- パッケージ別の許可行列（`unitRules`）で、workspace package 間と外部パッケージの依存を判定する。Core は Node 組み込みと相対 import のみ、Adapter は閉じ込めた技術（Playwright・AWS SDK）まで、Application は Core・Security・Adapter 経由に限る。
- 相対 import はパッケージ境界を越えられない（越える場合は workspace package 名で import する）。`apps/*` から別 Application の package への import も禁止する。
- 許可行列に未登録の unit（`apps/*`・`packages/*`）を検出したらテストを失敗させ、境界の追加を明示的にする。
- 合成ソース文字列の fixture で、許可・禁止の各ケースと行番号の報告を回帰テストする。

## Consequences

- 依存の違反がレビュー以前に CI で止まり、違反した `file:line` と import 指定子が出力される。
- 依存パッケージと設定ファイルが増えない。規則はリポジトリ固有の要求（相対越境・アプリ間・許可行列）に直接対応する。
- 検出器の保守は自前になる。字句走査は TypeScript の未知の構文で誤検出・検出漏れを起こし得るため、fixture の回帰テストで検知し、必要なら検出器を更新する。
- 変数に組み立てた指定子（`require(name)` 等）とテンプレートリテラルの `${}` の中の import は検出できない（検出漏れはレビューで補う）。
- 新しい package・Application の追加時に `unitRules` の更新が必要になる（未登録はテスト失敗）。

## Alternatives considered

- dependency-cruiser: 依存規則を宣言的に書け、実績もある。依存パッケージと設定ファイルが増え、リポジトリ固有の規則（相対 import の越境・アプリ間の禁止・許可行列）にはカスタム規則の記述が必要になるため採用しない。
- eslint-plugin-import / eslint-plugin-boundaries: 同様に ESLint 基盤の導入が必要で、現状 ESLint を持たないリポジトリでは検証基盤が二重になるため採用しない。
- TypeScript Compiler API: 既存の typescript devDependency で AST を正確に走査できる。テスト実行ごとに Program を構築するコストと、TypeScript の実装（バージョン）への追従の不確実性から、現時点では採用しない。誤検出が問題になったときの再検討候補とする。
- 正規表現のみの検出: 実装は最小だが、コメントや文字列の中の import 風の記述を誤検出し、CI を不当に止める。誤検出はゲートの信用を失わせるため、字句走査で文脈を判定する方式を採る。
