// MoneyForwardPort（core が定義）の Playwright 実装を置く。
// Page / Locator はこの package の外へ出さない（利用側は core の Port 契約だけに依存する）。
export type { PlaywrightMoneyForwardAdapterOptions } from './moneyforward/adapter.js'
export { PlaywrightMoneyForwardAdapter } from './moneyforward/adapter.js'
