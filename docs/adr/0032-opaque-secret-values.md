# 0032. 認証セッションと Secret の値を opaque 型で表す

- Status: Proposed
- Date: 2026-10-03

## Context

認証セッション（storageState）は Cookie 等を含む Secret であり、Application 境界で分離してログ・エラーへ出さない（ADR-0012・ADR-0013・ADR-0016）。Core は Playwright を知らず（ADR-0018）、Port の型に UI 詳細を出さない（ADR-0007）。

決める必要があったのは、セッションと Secret の値の型表現である。storageState の構造をそのまま型にすると Playwright の型が Core へ漏れ、文字列型にすると任意の文字列と区別できずログへの混入を型で防げない。また、値の生成・検証・消費をどの層の責務にするかを決めた。

## Decision

認証セッションと Secret の値を opaque な（ブランド付きの）型として定義する。

- `AuthSession` — MoneyForward ME の認証セッション。中身（storageState 等）を Core は知らない
- `SecretId` — Secret の識別子。実際の Secret 名・パスへの対応は Adapter が解釈する
- `SecretValue` — Secret の値。Core は中身を読まない

責務は層で分ける。生成・保存・検証はセキュリティ側（セッションはセッション管理、Secret は Secret Store Adapter）、消費（ブラウザへの適用・値の利用）は Adapter とする。Core は値を持ち回るだけにする。ブランドを公開 API（`src/index.ts`）から export しないため、Core の外で値を構築するには型キャストが必要になる。

## Consequences

- storageState の構造・Cookie が Core の型に現れず、Core からログ・エラーへ出す経路が型として存在しない。
- 値の構築側（セキュリティ・Adapter）にはキャストが必要になる。意図的なコストであり、境界を跨ぐ実装がレビューで見える形になる。
- Adapter は `AuthSession` を自身が知る形（storageState）へ変換する責務を持ち、変換の正当性は Adapter 内で完結する。
- Core のテストは値を作れないため、Port の契約は型検査（expectTypeOf）と合成データの純関数で固定する。

## Alternatives considered

- storageState（Playwright の型）をそのまま Core の型にする: Playwright の型が Core へ漏れ、ADR-0018 に違反するため却下。
- 文字列型（`string`）にする: opaque でなくなり任意の文字列と区別できない。セッションや Secret がログ・エラーへ流れる経路を型で防げないため却下。
- 構造を持つ DTO（cookies 配列等）を Core に定義する: Secret の中身が Core の型に現れ、ログ・エラーへの混入経路が型として生まれるため却下。
- ジェネリック型（`AuthSession<T>`）で中身を型引数にする: Core は中身を知らないため型引数が使い道を持たず、複雑さだけが増えるため却下。
