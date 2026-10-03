# 0035. lint と format に Biome を採用する

- Status: Accepted
- Date: 2026-10-03

## Context

リポジトリには lint / format の仕組みがなく、コードスタイルは開発者と AI エージェントの規律に依存している。CI の品質ゲートには format / lint を含む品質チェックが求められており、機械的に検証できる仕組みが必要になった。

制約は次のとおりである。本リポジトリは TypeScript 7.0 系（ESM / NodeNext）を使っており、lint ツールには TypeScript 7.0 を扱えることが求められる。検査は apps/*・packages/* を横断して行い、設定の置き場は増やさない。コードスタイルは既存コード（スペース 2・行幅 100・シングルクォート・セミコロンなし）に合わせ、導入時の一括整形の差分を最小化する。

実装を AI エージェントが行うため、規律だけでは守られない品質・安全・一貫性のルール（危険な構文、非同期の扱い、依存境界、テストの無効化など）を lint で機械的に強制する必要がある。あわせて、設定を読む人が「何を強制しているか」を理解できるようにする。

## Decision

lint と format の単一ツールとして Biome 2.5 系（`@biomejs/biome`）を採用する。

1. 設定はリポジトリルートの `biome.jsonc` に 1 つだけ置く。既存コードのスタイル（スペース 2・行幅 100・シングルクォート・セミコロンなし）に合わせる。
2. `vcs` 連携を有効にして `.gitignore` を尊重し、除外の管理を `.gitignore` の 1 箇所に集約する（node_modules・dist 等を Biome 設定へ二重に書かない）。
3. ルートの scripts に `pnpm lint`（`biome check --error-on-warnings .`。warning も失敗として扱う）と `pnpm format`（`biome check --write .`。整形・import 整列・安全な lint 修正の自動適用）を追加する。各 package には追加しない（ルートから全対象を 1 回で検査する）。
4. ルールの選び方は次のとおり。
   - 土台は `preset: "recommended"`。その上で、このリポジトリで強制するルールを各グループに `"error"` 明示で列挙し、ルールごとに日本語コメントで「何を検出するか／なぜ有効・無効か」を書く。`preset: "all"` とグループ一括の `"on"` は使わない（Biome の更新で新ルールが勝手に有効化され、意図しない破壊を招くため。追加は必ず明示的に行う）。
   - 誤検出のあるルールは「有効化しない」とし、理由を日本語コメントに残す（`noUnresolvedImports`・`noMisplacedAssertion`・`noNodejsModules`・`noProcessGlobal`・`noTernary`・`noContinue`・`noAwaitInLoops`・`useExportsLast`・`useExplicitType`・`useExplicitReturnType`・`noVoid`）。
   - `noSecrets` は既定値（entropyThreshold 41）では日本語の説明文を現行ツリーで 325 件誤検出したため、63 へ引き上げて有効化する（60 でも日本語のテスト名を 2 件誤検出し、63 で誤検出 0 件になる）。ただし閾値 63 ではエントロピー検知パスが確率的にしか働かず（ランダムな英数字トークンで実測 6/20）、検出の網は主にパターン一致（AWS アクセスキー・Slack・Twilio・URL パスワード等）である。検出範囲の拡大は、閾値を下げる変更（日本語の誤検出が 55 で 7 件・50 で 95 件に増える）ではなく、専用の Secret スキャナーで行う。閾値の前提（パターン一致の検出・日本語の非検出・値そのもの）はテスト（`tests/biome-no-secrets.test.ts`）で固定し、変更時に再測定を強制する。Secret の一次防衛は `.local/` の分離・`.gitignore`・権限の運用（ADR-0011 と README の機密情報の取り扱い）であり、このルールは補助である。
   - 型情報を必要とするルール（`noFloatingPromises` / `noMisusedPromises` / `useArraySortCompare`）は個別に `"error"` で有効化し、`linter.domains.types` は有効化しない。負のテストで、ドメイン無効のままでも明示したルールが動作することを確認済み（型推論エンジンの起動コストを常時払わないため）。`noUnsafeTypeAssertion` は types ドメイン外のルールで、同じく明示指定で有効にする。
   - test ドメイン（`noSkippedTests` / `noFocusedTests`）は vitest の宣言で自動的に有効になる。テストを無効化・一部実行したまま CI が気づかない事故を防ぐ。
   - Playwright のアンチパターン検出（`noPlaywright*`）を明示的に有効化する。待機・検証の成功判定を壊す書き方（暗黙の待機への依存・強制操作・eval 相当）を塞ぐ。時間ベースの待機が必要な箇所（上限つきの再取得・deadline 付きポーリング）は、理由付きの抑制コメントで許可する。
   - lint で機械的に強制できない規約（ログの allow list・semantic locator・状態変化での成功判定・`process.exit` の契約・`package.json` への依存宣言）は lint の対象外とし、レビュー（code-reviewer / security-reviewer）と Architecture Test（ADR-0034・`pnpm test:architecture`）に委譲する。
5. 緩和はパス別 `overrides` で「そのパスだけ」に閉じる。設定ファイルの `noDefaultExport`、テストの `noProcessEnv`・行数上限（関数・ファイル）・`noNamespaceImport`・`noMagicNumbers`・`noUnsafeTypeAssertion`・`noExcessiveCognitiveComplexity`（テストは表駆動で 1 ケースが長く、期待値・fixture の数値とテストダブルの型アサーションは本番コードの可読性・型安全に影響しないため）、CLI エントリの `noConsole`・`noProcessEnv`（環境変数の読み取りを設定境界モジュールに閉じる）、権限ビットを扱うファイルの `noBitwiseOperators`（`&` のみ許可）、`packages/adapter-aws/**` の `useNamingConvention`（AWS SDK / Secrets Manager の応答形状である `SecretString`・`VersionId`・`SecretBinary` 等の PascalCase をオブジェクトリテラルのプロパティ名としてそのまま書くため。許可は外部 API の形状名に限り、自作の設定・DTO の命名へは広げない）を許可する。
6. `packages/core/**` に `noRestrictedImports` を追加し、Playwright・AWS SDK（EC2 クライアントを含む）・Lambda・Appium・UIAutomator2・Android・Web Framework の import を分類ごとのメッセージ付きで機械的に塞ぐ。パッケージ名の指定だけでは subpath 付きの import が素通りするため、`/*`（1 階層）と `/**`（入れ子）の形も列挙する。検出は負のテスト（`tests/biome-core-boundary.test.ts`）で固定する。これは編集時に気づくための一次防波堤であり、Core の Framework / Runtime 非依存（ADR-0006）の最終的な保証は Architecture Test（ADR-0034）が担う。import 文のみを検査するため、`package.json` への依存追加は検出できない。
7. テストが import する `vitest` は、テストを持つ各 package（`apps/automation`・`packages/adapter-aws`・`packages/adapter-moneyforward-playwright`・`packages/core`・`packages/security`）の devDependencies に宣言する。ルート集約にしないのは、import する package と宣言が一致しない状態を作らないためである（`noUndeclaredDependencies` が検出する）。

## Consequences

- 整形と lint が 1 ツール・1 設定で完結し、CI の品質ゲートに組み込める。`pnpm lint` は warning も失敗として扱う検査専用、`pnpm format` は自動修正用として役割を分ける。
- 導入時に整形・import 整列で変わったファイルは 21 ファイル（整形 13・import 整列 17。重複を除く）にとどまり、以降の変更は機械的に統一される。厳格化に伴う既存コードの指摘は、適用時点のリポジトリで 182 件（error 177・warning 4・info 1）あり、波括弧の付与 104・import 整列 17・整形 13・正規表現のトップレベル化 12・未宣言依存（vitest）の宣言 10・配列型の統一 5・その他 21 だった。自動修正（`pnpm format` と `--write --unsafe`）と、振る舞いを変えない手動修正（正規表現のトップレベル化・比較関数の追加・async の除去・長い関数と複雑な関数の分割・マジックナンバーの定数化・危険な型アサーションの抑制または型ガード化など）で解消した。
- 型認識ルールを明示的に有効化しているため、Promise の未処理・不正な型アサーション・比較関数なしの sort を検出できる。一方で nursery のルールは実験的で、Biome の更新時に挙動が変わり得る。更新時は `biome migrate` と全ルールの再測定を行い、この ADR の前提（誤検出の有無・entropyThreshold）を再確認する。
- `noSecrets` の検出は補助で、閾値 63 の検出網はパターン一致が主であり、ランダムな英数字トークンの検出は確率的である（Decision を参照）。また検出時は候補文字列が診断メッセージに含まれ得るため、候補をコピー・転載しない。AI セッションでは作業を停止してユーザーへ報告する。CI へ lint を組み込む場合も、生の診断出力（候補文字列を含む）をそのままログへ流さず、表示はルール ID と件数にとどめる（Minimal Logging と Production Artifact を恒常保存しない原則）。
- `--error-on-warnings` のため、Biome の更新で追加された recommended の warning が将来 CI の lint を止め得る（意図した挙動。更新 PR で気づく）。
- Biome のバージョンアップ時は、`biome.jsonc` の `$schema` の更新と設定の移行（`biome migrate`）を伴う。

## Alternatives considered

- ESLint + typescript-eslint: typescript-eslint の peer 依存が `typescript >=4.8.4 <6.1.0` であり、TypeScript 7.0 を使う本リポジトリには導入できないため却下。
- oxlint + Prettier: 設定ファイルが lint 用と format 用の 2 つになり、単一ツールで完結する構成に劣るため見送り。
- oxfmt: 現行が pre-1.0（0.x）であり、安定版を前提とする品質ゲートには時期尚早として対象外。
- Biome + oxlint の併用（format を Biome・lint を oxlint に分ける案）: ツールと設定が 2 つになり、ルールの重複と指摘の統合を管理する必要が生じるため却下。
- `preset: "all"` でルールを有効化する案: 誤検出を含む全ルールが有効になり、抑制コメントが大量に必要になるため却下。
- `linter.domains.types` を `"recommended"` で有効化する案: 負のテストで個別指定の型認識ルールがドメイン無効でも動作することを確認できたため、型推論エンジンの起動コストを常時払わない構成を採用。
- `noSecrets` を無効化する案: entropyThreshold の調整で誤検出 0 件とパターン一致の Secret 形式の検出を両立できることを実測したため採用しない。
- `noSecrets` の閾値を下げて検出範囲を広げる案: 現行ツリーでの実測で 55 でも日本語の誤検出が 7 件、50 では 95 件発生し、誤検出の削減と検出範囲の拡大を同時に満たせないため却下（拡大は専用の Secret スキャナーで行う）。
- `vitest` をルート devDependencies に集約する案: import する package と宣言が一致せず `noUndeclaredDependencies` の意味が薄れるため却下。
