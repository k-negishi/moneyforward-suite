// SecretStorePort（core が定義）の AWS Secrets Manager 実装を公開する。
// AWS SDK への依存はこの package に閉じ込める（core・security へ持ち込まない）。
export type {
  AwsSecretsManagerSecretStoreConfig,
  SecretsManagerClientLike,
} from './secrets-manager/secret-store.js'
export { AwsSecretsManagerSecretStore } from './secrets-manager/secret-store.js'
