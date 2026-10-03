import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import type { ErrorCode, Result, SecretId, SecretStorePort, SecretValue } from '@mf-suite/core'
import { createDomainError } from '@mf-suite/core'

/**
 * 注入可能な Secrets Manager client の最小構造。`send(command)` だけを要求し、
 * テストでは合成の client（fake）を渡す。実装では @aws-sdk/client-secrets-manager の
 * client をそのまま渡せる（実 client の send は汎用なメソッド宣言のため、引数を unknown に
 * 広げたこの構造へ割り当てられる）。応答は unknown のまま受け取り、外部境界の値として
 * 実行時に形を検証する。
 */
export interface SecretsManagerClientLike {
  send(command: unknown): Promise<unknown>
}

/**
 * AWS Secrets Manager 実装の設定。Secret の識別子（論理 ID・物理名）はコードへ固定せず、
 * 必ず設定（Composition Root）から注入する。
 */
export interface AwsSecretsManagerSecretStoreConfig {
  /**
   * この Store が扱う論理 Secret ID（core の opaque 型）。構成側で 1 つだけ生成し、
   * 呼び出し側も同じ値を持ち回る（値の同一性で照合する）。
   */
  readonly secretId: SecretId
  /** GetSecretValue へ渡す物理的な Secret の名前または ARN。構成（環境変数等）から注入する。 */
  readonly secretName: string
  /** 注入された Secrets Manager client。 */
  readonly client: SecretsManagerClientLike
}

/**
 * Secret 値（opaque）を構築する。ブランドは core の public API から export されないため、
 * 生成側（この Adapter）にはキャストが必要になる（意図的なコスト。境界を跨ぐ実装を
 * レビューで可視にする）。キャストはこの 1 箇所に閉じ込める。
 */
// biome-ignore lint/nursery/noUnsafeTypeAssertion: ブランドは core の public API から export されず、opaque な SecretValue を Adapter で生成するにはこの 1 箇所のキャストが必要（境界を跨ぐ実装をレビューで可視にする）
const toSecretValue = (value: string): SecretValue => value as unknown as SecretValue

/**
 * 例外から分類の判定に使う name だけを読む。message は読まない（自由文字列を Error へ
 * 持ち込まない。message には Secret を含み得るため、Domain Error へ写像しない）。
 */
const readErrorName = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null || !('name' in error)) {
    return null
  }
  const name = error.name
  return typeof name === 'string' ? name : null
}

/**
 * Secrets Manager の取得時に投げられ得る例外を Domain Error の分類へ写像する。
 * 判定は例外の name だけで行う（message は使わない。message には Secret を含み得るため、
 * 分類の根拠としても結果の内容としても自由文字列を持ち込まない）。
 *
 * - ResourceNotFoundException → SECRET_NOT_FOUND（Secret の欠如）
 * - AccessDeniedException・UnrecognizedClientException・InvalidSignatureException・
 *   ExpiredTokenException・KMSAccessDeniedException → ACCESS_DENIED
 *   （権限または資格情報の不足・失効。資格情報を直さない限り同じ呼び出しの再試行では回復しない）
 * - InvalidParameterException・InvalidRequestException・PreconditionNotMetException・
 *   DecryptionFailure・EncryptionFailure → SECRET_INVALID
 *   （Secret や KMS の構成・状態の問題。再試行では回復しない）
 * - 上記以外（ThrottlingException・LimitExceededException・ネットワーク断・未知の例外）
 *   → TEMPORARY_FAILURE（再試行可）
 *
 * 未知の例外を再試行可へ倒すのは、判定不能を恒久失敗として捨てず、回復し得る失敗を再試行へ
 * 回す側に倒す方針による（ADR-0033 が語彙外の値を再試行可の UNKNOWN へ丸めるのと同じ思想）。
 * 恒久的に回復しない失敗は上のとおり明示的に分類し、再試行の対象から外す。
 */
const classifyFailure = (error: unknown): ErrorCode => {
  switch (readErrorName(error)) {
    case 'ResourceNotFoundException':
      return 'SECRET_NOT_FOUND'
    case 'AccessDeniedException':
    case 'UnrecognizedClientException':
    case 'InvalidSignatureException':
    case 'ExpiredTokenException':
    case 'KMSAccessDeniedException':
      return 'ACCESS_DENIED'
    case 'InvalidParameterException':
    case 'InvalidRequestException':
    case 'PreconditionNotMetException':
    case 'DecryptionFailure':
    case 'EncryptionFailure':
      return 'SECRET_INVALID'
    default:
      return 'TEMPORARY_FAILURE'
  }
}

/**
 * 応答から SecretString を取り出す。応答は外部境界の値のため、文字列であることを
 * 実行時に検証する。SecretBinary のみの Secret には対応しない（文字列の Secret だけを扱う）。
 * 取り出せない場合は null を返し、呼び出し側が SECRET_INVALID へ写像する。
 */
const readSecretString = (response: unknown): string | null => {
  if (typeof response !== 'object' || response === null || !('SecretString' in response)) {
    return null
  }
  const secretString = response.SecretString
  return typeof secretString === 'string' ? secretString : null
}

/**
 * SecretStorePort の AWS Secrets Manager 実装（ADR-0013）。
 *
 * Application ごとに分離した 1 つの Secret を、設定で指定された物理名（名前または ARN）で
 * 取得する。Secret の値はログ・エラーへ出さず、戻り値としてだけ返す。成功時の値は実行時に
 * 生の文字列のまま持ち回る（ブランドはファントム）ため、呼び出し側も直列化・ログ出力しない。
 *
 * 失敗は Domain Error の分類（SECRET_NOT_FOUND / SECRET_INVALID / ACCESS_DENIED /
 * TEMPORARY_FAILURE）へ写像する。例外は境界で捕捉し、呼び出し側が fail closed で
 * 扱えるように、すべて Result として返す（例外を投げ返さない）。
 */
export class AwsSecretsManagerSecretStore implements SecretStorePort {
  private readonly secretId: SecretId
  private readonly secretName: string
  private readonly client: SecretsManagerClientLike

  constructor(config: AwsSecretsManagerSecretStoreConfig) {
    // 設定の欠落は取得時ではなく生成時に停止する（fail fast。空の識別子で呼び出すと
    // 分類不能なサービス例外になり、構成の問題として扱えないため）。
    // 前後の空白は転記時の混入として取り除き、取り除いた結果が空の場合も同じ検証で停止する
    // （前後の空白だけの値で起動し、実行時に ResourceNotFound となる事故を防ぐ）。
    const secretName = config.secretName.trim()
    if (secretName.length === 0) {
      throw new Error('Secrets Manager の Secret 名（または ARN）が空です')
    }

    this.secretId = config.secretId
    this.secretName = secretName
    this.client = config.client
  }

  /**
   * 設定された論理 ID の Secret を取得する。
   * 要求された ID が設定と一致しない場合は、取得を試みずに SECRET_NOT_FOUND で失敗させる
   * （取り違えた Secret を返す経路を作らない）。
   */
  async getSecret(secretId: SecretId): Promise<Result<SecretValue>> {
    if (secretId !== this.secretId) {
      return { ok: false, error: createDomainError('SECRET_NOT_FOUND') }
    }

    let response: unknown
    try {
      response = await this.client.send(new GetSecretValueCommand({ SecretId: this.secretName }))
    } catch (error) {
      return { ok: false, error: createDomainError(classifyFailure(error)) }
    }

    const secretString = readSecretString(response)
    if (secretString === null || secretString.length === 0) {
      // 値の欠如・空・文字列以外は取得できた値として扱わない（形式不正）。
      return { ok: false, error: createDomainError('SECRET_INVALID') }
    }

    return { ok: true, value: toSecretValue(secretString) }
  }
}
