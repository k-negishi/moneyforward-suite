# ローカル E2E 検証 runbook（refresh-accounts）

## この runbook の位置づけ

ローカル環境で実 MoneyForward ME のセッションを使い、`refresh-accounts` CLI の利用者視点の動作を安全に確認するための手順をまとめる。手動ログイン（session CLI）→ headed での一括更新 → headless での同フロー確認、の順に進める。

- **対象**: 金融機関のデータ一括更新（`refresh-accounts`）。モバイル Suica は対象外である（[ADR-0029](adr/0029-exclude-mobile-suica.md)）。
- **対象外**: CAPTCHA・ワンタイムパスワード・追加本人確認の自動化（自動回避しない。[ADR-0015](adr/0015-no-auth-challenge-bypass.md)）、CI 上での実アカウント E2E、日次スケジュール実行の確認。
- **この文書は実機での初回検証を経て更新する初版である**。実機でしか確定できない事柄（画面表示・受付判定の実挙動）は、該当箇所で「実機で確認して記録する」ものとして区別して書く。
- コマンド名・出力の契約・終了コードの正本は [README](../README.md)（およびそこが参照する CLI ソース: `apps/automation/src/cli/`・`packages/adapter-moneyforward-playwright/src/cli/`）である。この runbook はそれらを検証手順として束ねたもので、相違を見つけたら README 側を正とする。

## 安全原則（最初に確認する）

- **Password はシステムが扱わない**。ログインはブラウザ上でユーザーが手動で行う（[ADR-0012](adr/0012-manual-auth-session-reuse.md)）。CLI には Password を渡す入力が存在しない。
- **Screenshot・HTML・HAR・Trace・Video を保存しない**（[ADR-0017](adr/0017-no-production-artifacts.md)）。E2E 中も同様とする。Playwright や開発支援ツールが Artifact ディレクトリ（`test-results/` 等）を生成していた場合は、内容を確認せず削除する。
- **検証記録に Cookie・セッショントークン・金融明細・口座名・行テキスト・スクリーンショットを含めない**（[ADR-0016](adr/0016-allow-list-logging.md)）。
- **AI セッションに実データを載せない**。AI に相談するときは、画面の内容そのものではなく、症状・status・errorCode・終了コードだけを伝える（後述「失敗時の切り分け」参照）。
- **セッションファイルは `.local/`（git 管理外）に置く**。`MF_SESSION_FILE` を使う場合も、絶対パス・git 管理外・個人専有の場所を指定する（セッションは Secret として扱う）。

## 前提とセットアップ

すべてのコマンドはリポジトリルートで実行する。

1. **必要環境**: Node.js `^22.20.0 || ^24.0.0 || >=26.0.0`、pnpm 12（ルートの `packageManager` で固定）。pnpm の導入方法を含む詳細は [README](../README.md) のセットアップを参照する。
2. **依存の導入**:

   ```sh
   pnpm install
   ```

3. **ビルド**:

   ```sh
   pnpm build
   ```

   各 CLI の script（`refresh-accounts` / `session:login` / `session:check`）は実行時に `pnpm build` を前置するため、通常は個別に叩かなくても最新の `dist` で実行される。初回に明示的に通しておくのは、依存関係の問題を CLI 実行（ブラウザ起動）まで持ち越さないためである。
4. **chromium の取得**（初回のみ。Adapter のブラウザテストと CLI の実行前に必要）:

   ```sh
   pnpm --filter @mf-suite/adapter-moneyforward-playwright exec playwright install chromium
   ```

5. **セッションの保存先の確認**（詳細は [README](../README.md) の session CLI を参照）:
   - 既定: `.local/moneyforward-session.json`（git 管理外）
   - 上書き: 環境変数 `MF_SESSION_FILE`（絶対パスのみ。git 管理外・個人専有の場所）
   - 権限: ファイル 0600・新規作成するディレクトリ 0700。他ユーザーが読める権限のファイルは読み込み時に拒否される（fail closed）。

## 事前ドライラン（実サービスに接続せずに確認する）

セッションを生成する前に、セッション不在のまま CLI を実行し、fail closed で停止することを確認する。この経路ではブラウザを起動せず、MoneyForward ME への通信も発生しない（セッションの欠如はファイル読込の時点で確定し、ページを開かずに停止する）。chromium の取得前でも実行できる。

セッションがまだ無い状態で次を実行し、いずれも `echo $?` で終了コードを確認する。

| 実行 | 期待する stdout | 期待する終了コード |
|---|---|---|
| `pnpm -C packages/adapter-moneyforward-playwright session:check` | `status=SESSION_MISSING` の 1 行。stderr にセッション再生成の案内 | 1 |
| `pnpm refresh-accounts` | `status=FAILURE errorCode=SESSION_MISSING` の 1 行。構造化ログは出ない | 2 |
| `pnpm refresh-accounts --headed --headless`（不正な引数の例: 重複指定。未知のフラグでも同じ） | `status=FAILURE errorCode=INVALID_JOB` の 1 行。stderr に使い方の案内 | 64 |

- `refresh-accounts` の構造化ログ（stderr の JSON 行）は Use Case を実行した場合の開始と完了の 2 行である。セッション不在・不正入力では Use Case に到達しないため出力されない（[README](../README.md) の出力の契約を参照）。
- いずれの実行でも、stderr には pnpm 自身の表示（実行したコマンドの行と、script が非ゼロで終わったときの `[ELIFECYCLE] Command failed with exit code N.`）が混ざる。CLI の契約は stdout の 1 行と終了コードである。
- **終了コードを確認するときは `-C` 形式を使う**。`--filter` による再帰実行は失敗時に終了コードを 1 に丸めて `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` を追加する。`-C` 形式は script の終了コードをそのまま返す（README「実装時の注意」と同じ理由）。

## 手順 A: セッションを生成する（headed の手動ログイン）

1. chromium を取得していなければ取得する（初回のみ）。

   ```sh
   pnpm --filter @mf-suite/adapter-moneyforward-playwright exec playwright install chromium
   ```

2. 実行する。

   ```sh
   pnpm -C packages/adapter-moneyforward-playwright session:login
   ```

3. headed ブラウザでログイン画面が開く。ターミナルにログイン案内と Enter 待ちのプロンプトが表示されるので、手動でログインする。**CAPTCHA・ワンタイムパスワード・新端末確認は自動回避されない**ため、自分で対応する（[ADR-0015](adr/0015-no-auth-challenge-bypass.md)）。
4. ログインが完了したら、ターミナルで Enter を押す。
5. 期待する出力と終了コード:

   | 結果 | stdout | 終了コード |
   |---|---|---|
   | 保存成功 | `status=SESSION_SAVED` と保存先の表示（既定は `.local/moneyforward-session.json` のリポジトリ相対パス。`MF_SESSION_FILE` でリポジトリ外を指定した場合はファイル名のみ） | 0 |
   | ログイン未完了・未認証 | `status=AUTH_REQUIRED`。stderr に再生成の案内 | 2 |
   | 判定不能（通信・ページ取得の失敗など） | `status=TEMPORARY_FAILURE` | 1 |

6. セッションの有効性を確認する。

   ```sh
   pnpm -C packages/adapter-moneyforward-playwright session:check
   ```

   期待: `status=SESSION_VALID`（と保存先の表示）・終了コード 0。

7. 失敗時の分岐:
   - `status=AUTH_REQUIRED`: ログインが完了していない（Enter 前の中断・EOF）、または認証チャレンジの検知。ブラウザでログインを完了してから再実行する。
   - `status=TEMPORARY_FAILURE`: 時間を置いて再実行する。改善しなければ手順 A をやり直してセッションを作り直す。

## 手順 B: headed で一括更新を実行する

1. 実行する。

   ```sh
   pnpm refresh-accounts --headed
   ```

2. 画面での確認（目視）:
   - 口座一覧ページが開き、金融機関の行と一括更新コントロール（「金融機関からのデータ一括更新」）が表示される。
   - 一括更新の受付が画面上で進む（「更新中」等の進行表示が出るか、行の更新時刻が変わる）。
   - CLI は「クリックできたこと」ではなく MoneyForward 側の受付・状態変化を観測して判定している（[ADR-0020](adr/0020-verify-success-by-state-change.md)）。目視の観点もこれに合わせ、「操作が進んだか」ではなく「受付されたか・状態が変化したか」を見る。
3. 結果の見方:
   - stdout: `status=...` の 1 行（失敗時は `errorCode=...` を続ける）。status と errorCode の全一覧は [README](../README.md) を参照する。
   - stderr: 構造化ログ（allow list の field だけの JSON 行）が開始と完了の 2 行。
   - 終了コード: 0 = 成功、4 = 部分成功、3 = 更新不要（現時点では発火しない）、2 = 認証が必要、64 = 不正入力、1 = その他。
4. 期待したい結果:
   - `status=SUCCESS`・終了コード 0: 受付が確認でき、失敗の観測がない状態。
   - `status=PARTIAL_SUCCESS`・終了コード 4: 受付は確認できたが、一部の行で失敗を観測した状態。画面を手動で確認する。
5. **完了（結果の反映）は CLI は待たない設計である**。CLI が返した時点の判定は「受付の確認」までであり、更新の完了は画面側で進み続け得る（[README](../README.md) の `SUCCESS` の意味を参照）。受付を確認できない場合は観測期限（既定 180 秒）まで待って `status=FAILURE errorCode=REFRESH_NOT_ACCEPTED`（終了コード 1）で停止する。

## 手順 C: headless で同フローを確認する

1. 実行する（既定は headless。`--headless` を明示してもよい）。

   ```sh
   pnpm refresh-accounts
   ```

2. 手順 B と同じ観点で、status・errorCode・終了コードが同じ判定になることを確認する。
3. headed と差異が出た場合の記録: 実行条件（headed / headless）と観測した違い（status・errorCode・終了コード・所要時間の目安）を検証記録に残す。差異が再現する場合は「UI 差異を見つけた場合」の扱いに従う。

## 特殊ケースの観測ポイント（実機で確認できた場合に記録する）

以下は無理に再現しなくてよい。遭遇した場合、または意図的に確認できた場合に、観測した内容を検証記録へ残す。

- **認証失効時の挙動**: 実行中にセッションが失効した場合、`status=FAILURE errorCode=AUTH_REQUIRED`（終了コード 2）で追加操作をせず安全に停止することを確認する。再開は `session:login` でセッションを再生成してから行う。
- **部分失敗の画面表示と `PARTIAL_SUCCESS` の対応**: 一部の行に失敗表示（例:「更新できませんでした」）が出た場合に、`status=PARTIAL_SUCCESS`（終了コード 4）になることを確認する。
- **受付が確認できない場合**: 受付の証拠（進行表示の新規出現・絶対日時の変化）が観測できないまま観測期限を過ぎると `status=FAILURE errorCode=REFRESH_NOT_ACCEPTED`（終了コード 1）で停止する。画面に失敗表示が新規に出た場合は `REFRESH_REJECTED` になる。
- **更新不要状態**: `NO_REFRESH_NEEDED`（終了コード 3）は現時点では判定条件が未確認のため発火しない設計である。更新不要な状況（直前に手動更新済み等）に遭遇したら、そのときの画面表示と CLI の結果（SUCCESS になるか等）を観測内容として記録する。
- **受付判定の安定性**: 同一条件（更新不要でない状態）で連続実行し、status と終了コードが一致するかを記録する。
- **画面の更新時刻表示**: 現在の受付判定は絶対日時（例: 2026/10/03 12:34）の変化のみを証拠に使う設計である。行の更新時刻が相対表記（「たった今」「5 分前」等）で表示されていないかを確認し、観測結果を記録する（相対表記だった場合は受付の証拠を取れない可能性がある）。
- **行の並び順の安定性**: 一括更新中に行の並び順が実行間で安定しているかを確認する（現在の受付判定は行の index で対応付けるため、行の増減・並び替えがあると判定を無効化して停止する）。
- **認証チャレンジ検知時の文言**: 認証チャレンジを検知した場合のみ、検知した旨を記録する。文言そのものは機密ではないが、画面全体の貼り付けはしない（画面には金融情報が含まれ得る）。

## 検証記録テンプレート

記録して**よい**項目:

| 項目 | 例 |
|---|---|
| 日時 | 2026-10-05 09:00 JST |
| 実行環境 | OS・Node のバージョン・pnpm のバージョン・実行した commit（`git rev-parse --short HEAD` で取得） |
| 手順 A〜C の実施状況 | A: 実施 / B: 実施 / C: 未実施 など |
| 実行したコマンド | `pnpm refresh-accounts --headed` 等 |
| 結果 | stdout の `status`・`errorCode` と終了コード（例: `status=SUCCESS`・0） |
| 目視確認の要約 | 「受付表示（更新中）を確認」「一部行に失敗表示」等の**定性表現** |
| 気づき・UI 差異 | 表示文言の変化、レイアウトの変更、所要時間の傾向 |
| 再実行の有無 | あり（2 回目も同じ status・終了コード）/ なし |

記録して**いけない**項目:

- Cookie・セッショントークン・storageState の中身
- 金融明細・残高・口座名・行テキスト・カード情報
- Screenshot・HTML・DOM・HAR・Trace・Video
- `MF_SESSION_FILE` の絶対パス（ユーザー名等を含み得るため。必要ならファイル名のみ）

コピペ用テンプレート:

| 項目 | 記録 |
|---|---|
| 日時 | |
| OS | |
| Node / pnpm | |
| 実行 commit | |
| 手順 A（セッション生成） | |
| 手順 B（headed 一括更新） | |
| 手順 C（headless） | |
| 実行コマンド | |
| status / errorCode | |
| 終了コード | |
| 目視確認の要約 | |
| 気づき・UI 差異 | |
| 再実行 | |

## 失敗時の切り分け

status / errorCode / 終了コードごとの全一覧と補足は [README](../README.md) のトラブルシュートを参照する。ここでは runbook 単体で判断できるよう最小限の対応を示す。

| 観測 | 意味 | 対応 |
|---|---|---|
| `status=FAILURE errorCode=AUTH_REQUIRED`（2） | 処理中にセッション失効を検知 | `session:login` で作り直す |
| `status=FAILURE errorCode=SESSION_MISSING`（2） | セッションが無い | `session:login` で生成する |
| `status=FAILURE errorCode=SESSION_INVALID`（2） | セッションの破損、または他ユーザーが読める権限 | 権限（0600）を確認し、`session:login` で作り直す |
| `status=FAILURE errorCode=INVALID_JOB`（64） | 引数の誤り | `--headed` / `--headless` 以外は受け付けない |
| `status=FAILURE errorCode=TEMPORARY_FAILURE`（1） | 一時障害、または判定不能 | 時間を置いて再実行する |
| `status=FAILURE errorCode=REFRESH_REJECTED`（1） | MoneyForward 側が明示的に拒否・失敗した（再試行しない） | 手動で画面の状態を確認する |
| `status=FAILURE errorCode=REFRESH_NOT_ACCEPTED` / `TARGET_NOT_FOUND` / `TARGET_AMBIGUOUS`（1） | 受付・対象を確認できなかった | 手動で画面を確認して再実行する |
| `status=FAILURE errorCode=UNKNOWN`（1） | 判定不能（設定エラーなどの例外を含む） | `MF_SESSION_FILE` の指定（絶対パス）等を確認する |
| `session:check` が `SESSION_INVALID`（1） | 破損、または他ユーザーが読める権限 | `ls -l .local/` で権限を確認し、`session:login` で作り直す |
| `session:check` が `AUTH_REQUIRED`（2） | セッション失効 | `session:login` で再生成する |
| `session:check` が `TEMPORARY_FAILURE`（1） | 有効性を判定できていない | ネットワークと MoneyForward ME の状態を確認して再実行する |

セッションの再生成:

```sh
pnpm -C packages/adapter-moneyforward-playwright session:login
```

AI に相談するときの伝え方: 画面の内容・HTML・Cookie を貼らず、症状・stdout の status / errorCode・終了コードだけを伝える（例:「`status=FAILURE errorCode=REFRESH_NOT_ACCEPTED` で終了コード 1。画面には失敗表示が見えない」）。

## UI 差異を見つけた場合

画面の文言・構造の変化で CLI が停止・誤判定する場合、場当たり的な回避（手元でのコード書き換え）で終わらせず、次のいずれかへ反映する。

- 受付・失敗・進行中の判定材料: `packages/adapter-moneyforward-playwright/src/moneyforward/row-changes.ts` のプローブ・パターン。判定は合成 HTML の fixture を使うテスト（`packages/adapter-moneyforward-playwright/test/`）で固定する。
- 対象（一括更新コントロール・口座行）の特定: `packages/adapter-moneyforward-playwright/src/moneyforward/locators.ts`。Locator は意味ベースの優先順位（role → accessible name → visible text → 安定属性、CSS は最後の手段）で選ぶ（[ADR-0019](adr/0019-semantic-locators.md)）。
- 認証チャレンジの検知: 同じく `locators.ts` の文言・入力欄の定義。

差異の内容（どの画面で何が変わったか）は検証記録に残す。判定材料の変更は、実機での再確認とテストの更新を伴わせる。

## 関連文書

- [README](../README.md) — コマンド・出力の契約・終了コード・機密情報の取り扱いの正本
- [docs/requirements.md](requirements.md) — 初期 Job `refresh-accounts` の要件
- [docs/architecture.md](architecture.md) — 依存境界と現在の構成
- [ADR-0012](adr/0012-manual-auth-session-reuse.md) — 手動ログインとセッション再利用
- [ADR-0015](adr/0015-no-auth-challenge-bypass.md) — 認証チャレンジを自動回避しない
- [ADR-0016](adr/0016-allow-list-logging.md) — ログの Allow List
- [ADR-0017](adr/0017-no-production-artifacts.md) — Production Artifact を恒常保存しない
- [ADR-0019](adr/0019-semantic-locators.md) — Locator は意味ベースで選択する
- [ADR-0020](adr/0020-verify-success-by-state-change.md) — 成功判定は状態変化で行う
- [ADR-0029](adr/0029-exclude-mobile-suica.md) — モバイル Suica を対象から外す
