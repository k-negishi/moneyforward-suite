# アーキテクチャ

この文書は MoneyForward Suite の現在の構造を示す生きている文書である。決定の理由は [ADR](adr/README.md) に、要件とロードマップは [requirements.md](requirements.md) にある。

## Repository 構造

初期構成は次のとおり（将来用の空 directory・package は作らない。ADR-0005）。

```text
moneyforward-suite/
├─ apps/
│   └─ automation/        # 実行エントリ（handler / composition-root / job-router）
├─ packages/
│   ├─ core/              # Domain / Application / Ports（Framework / Runtime 非依存）
│   ├─ adapter-moneyforward-playwright/
│   ├─ adapter-aws/
│   └─ security/
├─ package.json
├─ pnpm-workspace.yaml
└─ README.md
```

将来は apps/paypay-worker・apps/web、packages/contracts・packages/adapter-paypay-android、infra/automation・infra/paypay-worker・infra/web 等を追加できる（ADR-0004・ADR-0024）。

## 依存方向

すべての Business Application はヘキサゴナルアーキテクチャに従う（ADR-0003）。

```text
Driving Adapter → Input Port → Application Core → Output Port → Driven Adapter
```

- Application Core は Use Case・Domain Rule・Value Object・Port・Application Result・Domain Error を持つ。Playwright・AWS SDK・Lambda・EC2・Appium・Android SDK・Web Framework へ依存しない（ADR-0006）。
- Port は外部 Capability 単位で定義する（ADR-0007）。Concrete Adapter の生成と注入は各 Application の Composition Root で行う（ADR-0008）。
- MoneyForward ME Web 版の操作は Playwright Adapter に閉じ込め、Page / Locator / Browser / BrowserContext を Core へ漏らさない（ADR-0018）。
- 依存境界は Architecture Test で検証する（ADR-0022）。

## Application と Runtime

- **apps/automation**: 現在の唯一の Application。MoneyForward 系の軽量な Automation Job を集約し、初期 Runtime は AWS Lambda Container。Single Lambda + Job Router（ADR-0009）で Job（初期は refresh-accounts）を実行する。
- 将来の **apps/paypay-worker**（EC2 等）・**apps/web** は独立した Application とし、Runtime・Deployment・IAM・Secret を Application 単位で分離する（ADR-0004・ADR-0013・ADR-0014）。
