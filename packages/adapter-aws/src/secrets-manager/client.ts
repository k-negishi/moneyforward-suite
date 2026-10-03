import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import type { SecretsManagerClientLike } from './secret-store.js'

/**
 * Secrets Manager client の生成。AWS SDK への依存をこの package に閉じ込め、
 * Composition Root が実 client を組み立てられるようにする入口（Application からは
 * AWS SDK を import しない）。生成だけを行い、認証情報・接続の解決は SDK の既定に任せる。
 * テストでは `send(command)` だけを満たす合成 client へ差し替える。
 */

/** client 生成の設定。 */
export interface CreateSecretsManagerClientOptions {
  /**
   * AWS リージョン。省略時は SDK の既定解決（環境変数・共有設定）に任せる。
   * 前後の空白は除去し、空文字・空白のみは省略と同じ扱いにする。
   */
  readonly region?: string
}

/**
 * Secrets Manager client を作る。戻り値は `send(command)` だけを要求する最小構造とし、
 * AWS SDK の型を Application 側の型空間へ広げない（実 client はこの構造へ割り当てられる）。
 */
export const createSecretsManagerClient = (
  options: CreateSecretsManagerClientOptions = {},
): SecretsManagerClientLike => {
  // 空白を除去し、空になった指定は「未指定」として SDK の既定解決に委ねる
  // （空の region で生成して実行時に失敗する経路を作らない。空 secretName を拒否する
  // 構成側の検証とも整合させる）。
  const region = options.region?.trim()
  return region === undefined || region.length === 0
    ? new SecretsManagerClient({})
    : new SecretsManagerClient({ region })
}
