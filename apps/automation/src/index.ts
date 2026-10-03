// apps/automation の公開 API。Lambda のエントリと CLI（Driving Adapter）はここから組み立てる。
// Core・Adapter の内部実装は公開しない（Port と、組み上がった Handler だけを渡す）。
export type {
  AutomationOverrides,
  AwsAutomationOptions,
  AwsAutomationOverrides,
  LocalAutomationOptions,
} from './composition-root.js'
export { createAwsAutomation, createLocalAutomation } from './composition-root.js'
export type {
  AutomationHandler,
  AutomationHandlerDependencies,
  RefreshAccountsExecutor,
} from './handler.js'
export { createAutomationHandler } from './handler.js'
export type { JobInvocation, JobName } from './job-router.js'
export { routeJob } from './job-router.js'
export type { SecretStoreSessionProviderOptions, SessionProvider } from './session-provider.js'
export { createSecretStoreSessionProvider, createSessionFileProvider } from './session-provider.js'
