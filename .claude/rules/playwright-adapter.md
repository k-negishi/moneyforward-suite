---
paths:
  - "packages/adapter-moneyforward-playwright/**"
---

# Playwright Adapter の制約（ADR-0017 / ADR-0018〜ADR-0020）

- Page / Locator / Selector を core や呼び出し側へ漏らさない
- Locator は role > accessible name > visible text > 安定属性 の順で選ぶ（位置依存の指定を禁止）
- click できただけで成功と判定しない。MF 側の受付・状態変化を確認する
- Browser / BrowserContext は finally で必ず close する
- Screenshot / Video / Trace / HAR 等の Artifact を保存しない
