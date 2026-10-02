---
paths:
  - "packages/core/**"
---

# Core の制約（設計書 §9 / §12 / §14 / §51）

- playwright / aws-sdk / appium / android / Lambda・EC2 固有コードを import しない（Framework / Runtime 非依存）
- Port は外部 Capability 単位で定義し、過剰に分割しない
- Page / Locator / Selector 等の UI 詳細を型・インターフェースに出さない
- 相対 import には `.js` 拡張子を付ける（NodeNext の解決規則）
- 公開 API は `src/index.ts` からのみ export する
