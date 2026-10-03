# 企画: MoneyForward ME の取引カテゴリ自動補正

- Status: Exploring
- Date: 2026-10-03
- 決着時の反映先: ADR / 要件文書（Concluded・Dropped 時に記入）

## Problem

Money Forward ME は金融機関から取得した取引を家計簿カテゴリへ自動分類するが、常に適切とは限らない。実際に観測しているのは次の 2 パターンである。

- **未分類取引**: 計算対象であり、振替ではなく、大項目が「未分類」のまま残る取引。
- **支払手段が強く表れた取引**: 明細が `PayPay 食堂A` のように支払手段と加盟店で構成され、支払手段を主な根拠に分類される（または分類できない）取引。実際の支出目的は「食費 > 外食」であり、`PayPay` は支払手段にすぎない。

現状の回避策は、ユーザーが Money Forward ME 上で 1 件ずつ手でカテゴリを直すことである。取引が増えるほど負担が積み上がる。

## Solution

Money Forward ME 上の未分類・明らかな誤分類を、LLM（PoC では Amazon Bedrock 上の Claude Sonnet 4.5）で自動補正する。想定する Job 名は `categorize-transactions`（正式設計で再確認する）。

目標は「すべての取引を自動分類する」ことではない。**誤分類を避けながら、安全に自動化できる取引だけを自動補正する**ことである。判断材料が不足する取引は `abstain` する。

本書に記載する処理フロー、skip marker、taxonomy fingerprint、Port 名、バッチ方式などは**設計案**であり確定仕様ではない。本書をそのままコードへ変換せず、PoC コードもそのまま Production 構造へ昇格させない（「進め方」を参照）。

### 正本は Money Forward ME

- Money Forward ME が取引・カテゴリ・カテゴリ構成・ユーザーの手修正・メモの正本である。moneyforward-suite は第二の家計簿を作らない。
- カテゴリ名・カテゴリ構成・ユーザーの現在の判断について、ローカル側の情報を Money Forward ME より優先しない。
- カテゴリはコード上の enum や静的なマスタにしない。実行時に Money Forward ME から `largeCategoryId` / `largeCategoryName` / `middleCategoryId` / `middleCategoryName` を取得し、取得した現在のカテゴリだけを LLM の選択候補にする。ユーザーが MF 側でカテゴリを追加・改名・削除・構成変更しても、コードや設定の変更なしに次回実行で追随できることを目指す。

概念上の型（具体的な型・配置・責務は正式設計で決定する）:

```typescript
type CategoryCandidate = {
  largeCategoryId: string
  largeCategoryName: string
  middleCategoryId: string
  middleCategoryName: string
}
```

### ユーザーの現在の判断を最優先する

- すでにユーザーが具体的なカテゴリへ分類している取引には触らない。
- 自動分類した取引をユーザーが後から修正した場合、次回実行で元に戻してはならない。例えば Automation が「食費 > 外食」とし、その後ユーザーが「趣味・娯楽 > その他」へ変更した場合、次回実行で「食費 > 外食」へ戻さない。
- PayPay などの既知の誤分類パターンを再分類対象にする場合も、「ユーザー自身の修正」と「MF の自動分類」を安全に区別できるかを設計で確認する。区別できない場合は安全側に倒して対象範囲を狭くする。
- どの状態の取引を自動処理の対象とするかは、正式設計で明確な条件として定義する。

### 変更してよい範囲

変更対象は Money Forward ME の家計簿カテゴリとメモに限定する。銀行への直接ログイン・PayPay への直接ログイン・送金・決済・チャージ・投資・金融機関設定変更は対象外。失敗時の最大影響を「カテゴリまたはメモの誤更新」に限定する。

### LLM へ送る情報

必要最小限に限定する。

送信候補: 取引用の一時 ID、日付、金額、取引内容、金融機関、現在利用可能なカテゴリ候補。

送信しない: Money Forward 認証情報、Cookie、Session、カード番号、口座番号、AWS Secret、全資産情報、不要な過去取引。

### ログ

CloudWatch などへ実取引内容を恒久保存しない。残すのは件数などの集計にとどめる。

```text
category-job start
targets=14
classified=9
abstained=5
updated=9
skipped=5
bedrock_calls=1
```

加盟店名・金額・取引内容・個別カテゴリは通常ログに残さない。

### コストと影響範囲のガードレール

`maxTransactionsPerRun` / `maxBedrockCallsPerRun` 相当の上限を必ず設ける。目的は 2 つある。

- **コスト保護**: バグで対象が数千件になっても、大量に LLM へ送信しない。
- **誤更新範囲の制限**: 分類ロジックに問題があっても、1 回の実行で大量の MF データを書き換えない。

値は正式設計で決定する。

### LLM 方針

低性能モデルを大量に呼ぶより、十分な性能を持つモデルを必要な取引だけ少ない回数で呼ぶことを優先する。個人の AWS アカウントでは利用できるモデルに制約がある点も前提とする。コスト削減は、対象取引の限定・同じ abstain の繰り返し回避・複数取引の 1 リクエストへの集約・本番出力からの根拠説明などの削減・過去取引を無制限にプロンプトへ入れないことで行う。

### Fail Closed

次のいずれかに該当する場合は Money Forward を書き換えない。

- Bedrock 呼び出し失敗
- JSON parse 失敗
- response schema 不一致
- 対象 transaction ID 不一致
- response 件数不一致
- 未知 category ID
- カテゴリ一覧取得失敗
- 更新直前の MF 状態が想定と異なる
- ユーザー手修正の可能性を排除できない

### abstain は正常系

`abstain` はエラーではない。正常な分類結果の一種として扱い、CloudWatch の Error などにはしない。

### 概念上の処理フロー

```text
EventBridge Scheduler
        ↓
categorize-transactions
        ↓
Money Forward へアクセス
        ↓
現在カテゴリ一覧取得
        ↓
対象候補取得
        ↓
自動処理してよい取引だけ絞り込み
        ↓
skip 済みを除外
        ↓
件数上限適用
        ↓
対象 0 件 → NO_OP
        ↓
対象をまとめて LLM へ
        ↓
response validation
        ↓
classified → MF カテゴリ更新 → 再取得して verify
abstain    → 再試行抑止処理
```

外部分類 DB は持たない。これは要件理解のための概念図であり、正式設計ではない。

### refresh-accounts との関係

初期案は EventBridge Scheduler による独立実行（例: 03:00 に refresh-accounts、04:00 に categorize-transactions）。対象取引が存在しなければ NO_OP。Step Functions は現時点では必須としない。ただし、refresh 完了保証・重複起動・再実行・前回実行との競合・途中失敗は正式設計で考慮する。実測上必要なら Step Functions などを再検討する。

### アーキテクチャ候補（未確定）

```text
CategorizeTransactionsUseCase

MoneyForwardTransactionPort
TransactionClassifierPort
```

Adapter 候補は `adapter-moneyforward-playwright` と `adapter-bedrock`。正式設計で決定する。将来用の空 package は先に作らない。

### 既存設計との整合

- Playwright Adapter へビジネスルールを寄せすぎない。
- Application へ Money Forward 固有の DOM 知識を漏らさない。
- Core へ AWS SDK / Bedrock SDK の型を漏らさない。
- Money Forward のカテゴリを静的な Domain enum にしない。
- 既存 ADR と矛盾する場合、コードを無理に合わせるのではなく、既存 ADR を守るか、ADR 変更が必要であることを明示する。

### 進め方（設計先行）

この機能の正式な設計はまだ存在しない。PoC コードをそのまま Production 構造へ昇格させない。既存の README・ADR・実装を読んだうえで、次の順で進める。

1. 制約と既存設計を把握する
2. 選択肢を比較する
3. 正式な設計を行う
4. 必要なら ADR を追加・更新する
5. 実装する

設計フェーズで最低限残す成果物:

- 要件整理 / ユースケース / 対象・非対象条件 / 処理フロー
- Domain / Application / Port / Adapter の責務と主要 interface 案
- Failure Mode 一覧 / セキュリティ設計 / 冪等性・再実行設計
- LLM コストガードレール / テスト戦略
- 採用案・不採用案と理由

設計が固まる前に大量の package・interface・抽象化を追加しない。

### 次の PoC（優先順）

- **PoC A: カテゴリ候補取得** — Money Forward ME から `largeCategoryId` / `largeCategoryName` / `middleCategoryId` / `middleCategoryName` を動的取得できるか確認する。
- **PoC B: カテゴリ更新** — 対象 1 件で「現在状態取得 → カテゴリ更新 → 再取得 → 状態変化確認」を行う。HTTP 成功だけを成功条件にしない。
- **PoC C: メモ更新** — skip marker を安全に追記できるか確認する。更新 endpoint・必要 parameter・既存メモの保持・再取得確認・カテゴリ変更との同時更新可否を確認する。
- **PoC D: カテゴリ構成変更への追随** — MF 側でテスト用カテゴリ構成を変更し、「以前 abstain → カテゴリ構成変更 → 必要に応じて再分類」できることを確認する。fingerprint 方式を使うかはこの PoC の後に設計する。
- **PoC E: MF 自身の分類学習** — Automation でカテゴリ変更した後、同様の新規明細が MF 自身によって期待カテゴリへ分類されるか確認する。

### 設計思想

```text
Money Forward ME    = 台帳・カテゴリ・ユーザー判断の正本
LLM                 = 分類補助
moneyforward-suite  = 両者を安全につなぐ Automation
```

ユーザーが Money Forward ME を普段どおり操作しても壊れないことを重視する。AI の賢さそのものより、次を優先する。

- ユーザーの手修正を尊重する
- 誤更新しない
- 状態を必要以上に増やさない
- Money Forward の現在状態へ追随する
- LLM を無駄に呼ばない
- 一度の事故範囲を限定する
- 責務境界を崩さない
- 実装前にきちんと設計する

## Appetite

明示的な時間上限は置かない。次の PoC（A〜E）の結果が揃った時点を、正式設計へ進む判断点とする。

## Rabbit holes

- **skip marker を Money Forward のメモ欄へ置く方式**: LLM が一度判断できなかった取引を毎回送るのは避けたいが、そのためだけに DynamoDB などの永続ストアを追加するのは現時点では過剰。第一候補は MF のメモ欄（例: `[mfs:cat:v1:skip]`）だが、これも確定仕様ではなく PoC 対象。カテゴリ変更と同時に更新できるかを含めて PoC C で確認する。
- **taxonomy fingerprint**: カテゴリ構成が変化したときに、以前 abstain した取引を再評価できるようにするための実現案の 1 つ（例: `[mfs:cat:v1:skip:a81f2c]`）。確定仕様ではなく、無条件に実装しない。「カテゴリ構成が変化したら以前の abstain を再評価できること」を要件として、classifier version のみ・skip marker の期限・手動再評価・より単純な方法と比較する。単なるカテゴリ名変更だけで大量の再分類が発生することが望ましいかも併せて検討する。
- **classifier versioning**: プロンプトや分類戦略を大きく変更したら version を上げ、以前の abstain を新しい分類器で再評価する案。管理方法は正式設計で決定する。
- **過去取引の Few-shot**: 同じ加盟店の過去の MF カテゴリを教師にする構成は魅力だが、過去月取得・merchant normalization・履歴検索・教師データ選択・Few-shot 生成が必要で、初期の個人開発としては複雑性が高い。まず MF 自身の分類機能が使えるかを PoC E で確認し、不足が観測された場合に改めて設計する。
- **バッチの atomicity**: 例えば 10 件送信して 9 件正常・1 件 schema 不正だったとき、9 件だけ採用するのかバッチ全体を破棄するのか。MF 更新も 1〜4 件成功・5 件目失敗の扱いがある。MF 側は DB transaction のように完全にロールバックできるとは限らないため、LLM レスポンスの atomicity・MF 更新の atomicity・部分成功・再実行を別々に設計する。
- **Step Functions の導入**: refresh 完了保証・重複起動・競合が実測で問題になってから検討する。先回りして導入しない。
- **監査履歴**: classified した明細へ「AI によって変更された」印を恒久記録するか。個人用途では不要な状態を増やさないことを優先し、必須とはしない。ただし「自分で変えたのか Automation が変えたのか」を知る必要があるかは正式設計で一度判断し、不要なら保持しないと明示的に決める。

## No-gos

必要性が PoC または実際の運用から観測されるまで、次を導入しない。

```text
独自家計簿 DB
独自カテゴリマスタ
Merchant → Category 永続 DB
DynamoDB による分類履歴
ベクトル DB
RAG
大規模な Rule Engine
Step Functions
Agent 化
複数 LLM Router
Dashboard
```

その他、意図的にやらないこと。

- MVP では過去分類（Few-shot）を実装しない。
- 銀行・PayPay への直接ログイン、送金・決済・チャージ・投資・金融機関設定変更は対象外とする。
- 公開 Git リポジトリへ実データをコミットしない。実 CSV・実取引一覧・生活圏を推測できる加盟店・個人的な利用先・Session・Cookie・認証情報・Playwright artifact・実データを含む Screenshot や LLM response を含める。実データの PoC は `.local/` などの git 管理外の領域でのみ行う。
- 将来使うかもしれないだけの空 package・抽象化を先回りして作らない。
- 任意コマンドを実行できる汎用 Executor を作らない（既存方針）。

## 未解決の問い

正式設計で決める（PoC の結果と要件を入力にする）。

- Use Case の責務
- Domain / Application / Port / Adapter の境界
- MoneyForward Port・Bedrock Port の粒度
- 動的カテゴリの表現
- 自動分類の対象条件（どの状態の取引を対象にするか）
- ユーザーの手修正を上書きしない仕組み
- abstain の再試行方針 / classifier versioning / カテゴリ構成変更への追随方法
- LLM batching / LLM response validation / 部分失敗
- Money Forward の更新順序 / 冪等性 / 重複実行 / 更新後の verification / retry
- EventBridge との境界 / 最大処理件数 / 最大 LLM 呼び出し回数
- ログ / 金融情報保護 / IAM / Secrets / テスト戦略 / Failure Mode

比較し、採用理由と不採用理由を説明する。

- DynamoDB と MF メモのどちらに skip 状態を持つか
- taxonomy fingerprint と classifier version のみのどちらで再評価するか
- 1 件ずつ LLM へ送るか、バッチにするか
- バッチ全体を Fail Closed にするか、transaction 単位で validation するか
- 過去履歴を利用するか、MF 自身の分類機能に任せるか
- EventBridge のみか、Step Functions を導入するか

その他の確認事項。

- 監査履歴を持たない場合、持たないと明示的に決定する。
- 想定 Job 名 `categorize-transactions` の妥当性。
- 本番プロンプトの設計。PoC プロンプトをそのまま流用せず、トークン削減のため出力を `id` / `decision` / `largeCategoryId` / `middleCategoryId` 程度まで削る案を検討する。返却された ID は Application 側で必ず入力 candidate 一覧との一致を検証する。
- 現在の要件文書は AI 機能を「現時点で実装しないもの」に挙げている。決着時に要件文書へ反映する。

## 付録A: 実施済み PoC（2026 年 9 月）

2026 年 9 月の実データを使用し、Bedrock Playground 上で Claude Sonnet 4.5 を評価した。PayPay 系明細 20 件を対象とする。正解ラベルは Money Forward ME 上でユーザーが設定済みのカテゴリで、LLM 入力には正解カテゴリを含めていない。

結果:

```text
対象        20
classified  11
abstain      9
```

classified した 11 件の一致:

```text
大項目一致        11 / 11
大項目 + 中項目   10 / 11
```

1 件だけ中項目の判断がユーザー分類と一致しなかった。一般化した例:

```text
○○薬局

Model:
健康・医療 > 薬
confidence = 0.96

ユーザー分類:
健康・医療 > 医療費
```

取引文字列だけでは処方関連・市販薬購入・その他薬局利用を区別できないため、モデル能力だけでなく入力情報不足の問題と考えられる。

### 知見

- Claude Sonnet 4.5 は、取引内容から業種が読み取れるケースでは高精度だった（鍼灸・整体、アイブロウサロン、食堂、餃子、もみ処、蕎麦、hair salon など）。
- 情報不足のケースでは `abstain` が必要。
- `confidence >= 0.95` だから安全、とは言えない。LLM 自身の confidence を校正済み確率として扱わない。

## 付録B: PoC プロンプト

Bedrock Playground で利用した思想を整理したもの。**本番プロンプトはこれをそのまま流用せず、正式設計時に改めて設計すること。**

### System Prompt

```text
あなたは、Money Forward ME の支出取引を分類する家計簿カテゴリ分類器です。

入力として1件または複数の取引が与えられます。
各取引について、取引内容から実際の支出目的を推定し、指定されたカテゴリ候補の中から最も適切な「大項目」と「中項目」を選択してください。

これは分類性能を測定するPoCです。
文章作成、アドバイス、一般的な説明は不要です。

# 重要な制約

- 複数の取引が入力された場合も、それぞれ独立して判定してください。
- 同じ入力内に存在する他の取引を、正解例・過去履歴として利用してはいけません。
- 同一加盟店が複数登場しても、他の行の分類結果を根拠としてはいけません。
- 必ず入力されたカテゴリ候補の中から選択してください。
- 存在しないカテゴリを生成してはいけません。
- 十分な根拠がない場合は無理に分類せず abstain してください。

# 分類原則

1. 支払手段ではなく「何にお金を使ったか」で分類してください。

2. PayPay、Suica、QUICPay、iD、クレジットカード等は支払手段です。
支払手段だけを理由にカテゴリを決めてはいけません。

3. `PayPay XXXXX` の場合、`PayPay` は支払手段として除外し、後続の `XXXXX` を加盟店名・サービス名として重視してください。

4. 金融機関名も原則として支払手段です。
購入目的の主な判断根拠にはしないでください。

5. 加盟店名から業種・提供サービスを合理的に判断できる場合、その情報を主要な分類根拠として使用してください。

6. 加盟店名自体に業種を示す情報が含まれている場合は強い根拠として扱ってください。

例:
- 食堂、レストラン、餃子、蕎麦、ラーメン等 → 飲食店である可能性が高い
- 薬局 → 健康・医療関連である可能性が高い
- 整体、鍼灸、もみ処等 → ボディケアである可能性が高い
- hair salon、美容院等 → 美容院・理髪である可能性が高い
- アイブロウ、眉毛サロン等 → 眉毛サロンである可能性が高い

7. 金額と日付は補助情報として利用できますが、加盟店・サービス情報より優先してはいけません。

8. 一般知識として実在する店舗・サービスを知っている場合、その知識を利用して構いません。

9. 知らない店舗について、店舗名や金額だけから架空の業種・サービス内容を作ってはいけません。

10. Money Forward上で現在設定されているカテゴリを入力に含める場合でも、それを正解とはみなさず独立して判断してください。

# 判断手順

各取引について内部的に以下の順番で判断してください。

1. 支払手段を除去する
2. 加盟店名・サービス名を特定する
3. 業種・サービス内容を判断する
4. 実際の支出目的を判断する
5. 候補カテゴリから最も適切な大項目・中項目を選択する
6. 根拠不足なら abstain する

# Confidence

confidence は0.00〜1.00で返してください。

0.98〜1.00:
取引名そのものからほぼ一意に判断できる

0.90〜0.97:
強い根拠があり、かなり確信している

0.70〜0.89:
有力だが別カテゴリの可能性もある

0.00〜0.69:
自動分類するには根拠不足

0.70未満の場合は原則 abstain としてください。

confidenceを高くすることより、誤分類を避けることを優先してください。

# 出力

JSON以外は出力しないでください。
Markdownコードブロックも使用しないでください。

単一取引:

{
  "decision": "classified",
  "category": "大項目",
  "subCategory": "中項目",
  "confidence": 0.95,
  "merchant": "加盟店名",
  "reason": "簡潔な分類根拠"
}

abstain:

{
  "decision": "abstain",
  "category": null,
  "subCategory": null,
  "confidence": 0.40,
  "merchant": "推定できた加盟店名",
  "reason": "判断できない理由"
}

複数取引:

{
  "results": [
    {
      "id": "P01",
      "decision": "classified",
      "category": "大項目",
      "subCategory": "中項目",
      "confidence": 0.95,
      "merchant": "加盟店名",
      "reason": "分類根拠"
    }
  ]
}

入力されたすべてのIDについて必ず結果を返してください。
```

### User Prompt

```text
以下の取引を分類してください。

日付: 2026-09-25
内容: PayPay 食堂A
金額: -1078円
金融機関: カードA

選択可能なカテゴリ:

<Money Forward MEから取得したカテゴリ一覧>
```

## 付録C: Git 管理する PoC fixture

この fixture は LLM の精度評価用ではない。用途は JSON schema・batch 処理・response validation・classified / abstain 分岐・Money Forward 更新フローのコードテストである。実際の LLM 分類精度評価は git 管理外のローカル実データで行う。

```json
{
  "transactions": [
    { "id": "F01", "description": "PayPay 鍼灸・整体 A", "amount": -7900 },
    { "id": "F02", "description": "PayPay 飲食店A", "amount": -3014 },
    { "id": "F03", "description": "PayPay アイブロウサロン A", "amount": -4900 },
    { "id": "F04", "description": "PayPay 食堂A", "amount": -1078 },
    { "id": "F05", "description": "PayPay ○○薬局", "amount": -1780 },
    { "id": "F06", "description": "PayPay 餃子店A", "amount": -1910 },
    { "id": "F07", "description": "PayPay 事業者A", "amount": -2000 },
    { "id": "F08", "description": "PayPay チャーシュー店A", "amount": -1740 },
    { "id": "F09", "description": "PayPay サービス店A", "amount": -10400 },
    { "id": "F10", "description": "PayPay 会員店A", "amount": -1000 },
    { "id": "F11", "description": "PayPay もみ処 A", "amount": -6000 },
    { "id": "F12", "description": "PayPay 焼肉店A", "amount": -8305 },
    { "id": "F13", "description": "PayPay 肉蕎麦店A", "amount": -950 },
    { "id": "F14", "description": "PayPay hair salon A", "amount": -3200 }
  ]
}
```

## 決着

未決着。
