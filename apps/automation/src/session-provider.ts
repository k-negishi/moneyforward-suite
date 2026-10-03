import type { AuthSession, Result, SecretId, SecretStorePort } from '@mf-suite/core'
import { createDomainError } from '@mf-suite/core'
import type { SessionLoadResult } from '@mf-suite/security'
import {
  parseSessionSecret,
  readSessionFile,
  resolveSessionFilePath,
  toAuthSession,
} from '@mf-suite/security'

/**
 * 実行の直前に認証セッションを取得する口。取得元（ローカルのセッションファイル /
 * AWS の Secret Store）の違いをここへ閉じ、Handler は取得元を知らない。
 * 取得できたセッションは opaque な AuthSession とし、内容をログ・エラーへ出さない。
 */

/** セッションを取得する。取得できない場合は分類（Domain Error）で返す（fail closed）。 */
export type SessionProvider = () => Promise<Result<AuthSession>>

/**
 * セッション読込の結果を Port の契約（Result）へ写す。欠如（SESSION_MISSING）と
 * 破損・失効（SESSION_INVALID）を区別し、呼び出し側が fail closed で停止できるようにする。
 */
const toSessionResult = (load: SessionLoadResult): Result<AuthSession> => {
  switch (load.status) {
    case 'OK':
      return { ok: true, value: toAuthSession(load.sessionState) }
    case 'SESSION_MISSING':
      return { ok: false, error: createDomainError('SESSION_MISSING') }
    case 'SESSION_INVALID':
      return { ok: false, error: createDomainError('SESSION_INVALID') }
  }
}

/**
 * セッションファイルから取得する SessionProvider（ローカル実行用）。
 * パスの既定解決は security に任せ、環境変数の読み取りを Application へ持ち込まない。
 * テストでは一時ファイルのパスを渡す（実際のセッションファイルには触れない）。
 */
export const createSessionFileProvider = (
  filePath: string = resolveSessionFilePath(),
): SessionProvider => {
  // 読み込みは同期だが、SessionProvider の契約（Promise）へ揃えて取得元を差し替え可能にする。
  return () => Promise.resolve(toSessionResult(readSessionFile(filePath)))
}

/** Secret Store から取得する SessionProvider の設定。 */
export interface SecretStoreSessionProviderOptions {
  readonly secretStore: SecretStorePort
  /** 取得対象の論理 Secret ID。構成側（Composition Root）が生成し、Store と同じ値を持つ。 */
  readonly secretId: SecretId
}

/**
 * Secret Store の Secret から取得する SessionProvider（AWS 実行用）。
 * Secret の取得失敗は Store の分類（SECRET_NOT_FOUND / SECRET_INVALID / ACCESS_DENIED /
 * TEMPORARY_FAILURE）をそのまま返し、取得できた値の検証は security の
 * parseSessionSecret に任せる（Application は Secret の中身を解釈しない）。
 */
export const createSecretStoreSessionProvider = (
  options: SecretStoreSessionProviderOptions,
): SessionProvider => {
  return async () => {
    const secret = await options.secretStore.getSecret(options.secretId)
    if (!secret.ok) {
      return { ok: false, error: secret.error }
    }
    return toSessionResult(parseSessionSecret(secret.value))
  }
}
