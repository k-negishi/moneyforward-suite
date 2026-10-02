---
paths:
  - "packages/security/**"
  - "apps/automation/**"
---

# 認証・ログの制約（設計書 §27〜§34）

- Secret / Cookie / Session Token / storageState / 金融明細 / HTML / DOM をログ・エラー・委譲メッセージに出さない
- ログは allow-list した field のみを出力する（自由文字列をそのまま出さない）
- 認証チャレンジ（CAPTCHA / OTP / 新端末確認）を自動回避しない。検知したら停止し AUTH_REQUIRED とする
- 欠如・破損・失効は区別して fail closed（推測で続行しない）
