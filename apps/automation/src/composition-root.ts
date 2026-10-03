import type { SecretsManagerClientLike } from '@mf-suite/adapter-aws'
import {
  AwsSecretsManagerSecretStore,
  createSecretId,
  createSecretsManagerClient,
} from '@mf-suite/adapter-aws'
import { PlaywrightMoneyForwardAdapter } from '@mf-suite/adapter-moneyforward-playwright'
import type { LoggerPort, MoneyForwardPort, SecretStorePort } from '@mf-suite/core'
import { RefreshAccountsUseCase } from '@mf-suite/core'
import { createStructuredLogger, resolveSessionFilePath } from '@mf-suite/security'
import type { AutomationHandler } from './handler.js'
import { createAutomationHandler } from './handler.js'
import type { SessionProvider } from './session-provider.js'
import { createSecretStoreSessionProvider, createSessionFileProvider } from './session-provider.js'

/**
 * Composition Root（ADR-0008）。Concrete Adapter の生成と Port への注入をこのファイルに集約し、
 * Core へは Port だけを渡す。環境ごとの違い（ローカルのセッションファイル / AWS の Secret Store）は
 * 組み立ての差として表し、Handler と Use Case は環境を知らない。
 * テストでは overrides で Port・Session Provider を fake に差し替えられる（実 Adapter の検証は
 * 各 Adapter のテストが担う）。
 */

/** テスト用の差し替え口。省略した依存は実 Adapter で組み立てる。 */
export interface AutomationOverrides {
  readonly moneyForward?: MoneyForwardPort
  readonly logger?: LoggerPort
  // 取得元の違い（ファイル / Secret Store）ごと差し替えるための口。取得失敗の分類も含めて差し替わる。
  readonly sessionProvider?: SessionProvider
}

/** AWS 構成の差し替え口。Secret Store は Port でも Adapter の client でも差し替えられる。 */
export interface AwsAutomationOverrides extends AutomationOverrides {
  readonly secretStore?: SecretStorePort
  readonly secretsClient?: SecretsManagerClientLike
}

/** ローカル実行の設定。 */
export interface LocalAutomationOptions {
  /** ブラウザを表示するか。ローカルでは headed / headless を呼び出し側が選ぶ。 */
  readonly headless: boolean
  /** セッションファイルのパス。省略時は security の既定解決（リポジトリ内の .local/ 配下）に任せる。 */
  readonly sessionFilePath?: string
}

/** AWS 実行の設定。Secret の識別子はコードへ固定せず、呼び出し側（エントリ）が設定から注入する。 */
export interface AwsAutomationOptions {
  /** セッションを保存した Secret の名前または ARN。 */
  readonly secretName: string
  /** AWS リージョン。省略時は AWS SDK の既定解決（環境変数等）に任せる。 */
  readonly region?: string
}

/** Use Case を、注入された Port から組み立てる。Core は Concrete Adapter を知らない。 */
const createUseCase = (
  moneyForward: MoneyForwardPort,
  logger: LoggerPort,
): RefreshAccountsUseCase => new RefreshAccountsUseCase({ moneyForward, logger })

/** ログは allow-list の構造化ロガー（security）を使い、Application 名を束ねる。 */
const createLogger = (overrides: AutomationOverrides): LoggerPort =>
  overrides.logger ?? createStructuredLogger({ application: 'automation' })

/** AWS 実行用の Session Provider を、Secret Store（adapter-aws）から組み立てる。 */
const createAwsSessionProvider = (
  options: AwsAutomationOptions,
  overrides: AwsAutomationOverrides,
): SessionProvider => {
  const secretId = createSecretId(options.secretName)
  const secretStore =
    overrides.secretStore ??
    new AwsSecretsManagerSecretStore({
      secretId,
      secretName: options.secretName,
      client: overrides.secretsClient ?? createSecretsManagerClient({ region: options.region }),
    })

  return createSecretStoreSessionProvider({ secretStore, secretId })
}

/**
 * ローカル実行の Application を組み立てる。
 * Playwright Adapter・構造化ロガー・セッションファイルの Session Provider を使う。
 * セッションの読み込みは実行のたびに行い、ファイルの更新（手動ログインの再実行）を反映する。
 */
export const createLocalAutomation = (
  options: LocalAutomationOptions,
  overrides: AutomationOverrides = {},
): AutomationHandler => {
  const moneyForward =
    overrides.moneyForward ?? new PlaywrightMoneyForwardAdapter({ headless: options.headless })
  const sessionProvider =
    overrides.sessionProvider ??
    createSessionFileProvider(options.sessionFilePath ?? resolveSessionFilePath())

  return createAutomationHandler({
    useCase: createUseCase(moneyForward, createLogger(overrides)),
    sessionProvider,
  })
}

/**
 * AWS（Lambda）実行の Application を組み立てる。
 * セッションは Secrets Manager の Secret から取得し、ブラウザは常に headless で動かす
 * （実行環境に表示がなく、headed を指定できる口を作らない）。リトライ制御・待機は実行基盤の責務。
 */
export const createAwsAutomation = (
  options: AwsAutomationOptions,
  overrides: AwsAutomationOverrides = {},
): AutomationHandler => {
  const moneyForward =
    overrides.moneyForward ?? new PlaywrightMoneyForwardAdapter({ headless: true })
  const sessionProvider = overrides.sessionProvider ?? createAwsSessionProvider(options, overrides)

  return createAutomationHandler({
    useCase: createUseCase(moneyForward, createLogger(overrides)),
    sessionProvider,
  })
}
