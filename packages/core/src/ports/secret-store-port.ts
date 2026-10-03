import type { Result } from '../result.js'

declare const secretIdBrand: unique symbol
declare const secretValueBrand: unique symbol

/**
 * Secret の識別子（opaque）。実際の Secret 名・パスへの対応は Adapter の責務とし、
 * Core は論理的な識別子として持ち回るだけにする。
 */
export type SecretId = { readonly [secretIdBrand]: 'SecretId' }

/**
 * Secret の値（opaque）。Core は中身を読まない。ログ・エラー・別の Application へ
 * 出さない（Minimal Logging・Secret 分離）。
 */
export type SecretValue = { readonly [secretValueBrand]: 'SecretValue' }

/**
 * Secret を取得する能力（Port）。
 * 欠如・破損・権限不足は Domain Error の分類（SECRET_NOT_FOUND / SECRET_INVALID /
 * ACCESS_DENIED）で区別し、呼び出し側が fail closed で扱えるようにする。
 */
export interface SecretStorePort {
  getSecret(secretId: SecretId): Promise<Result<SecretValue>>
}
