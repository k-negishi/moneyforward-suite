import type { DomainError, Result } from '@mf-suite/core'
import { createDomainError } from '@mf-suite/core'

/**
 * Job Router。外部入力（Lambda イベント）を検証し、許可した Job の実行内容へ振り分ける。
 * 実行できる Job はこのファイルの Allow List に固定し、入力から URL・Selector・JavaScript・
 * Shell Command・Playwright 処理を指定する経路を作らない（未知・欠落・形式不正・余剰フィールドは
 * すべて拒否側へ倒す fail closed）。
 */

/** 許可する Job の語彙。値の追加はこの表と JobName の両方へ明示的に行う。 */
export type JobName = 'refresh-accounts'

/**
 * Allow List の定義（唯一の定義）。Record 型で網羅を型検査に強制し、JobName へ値を追加したときの
 * 更新漏れをコンパイルエラーにする。
 */
const ALLOWED_JOBS: Readonly<Record<JobName, true>> = {
  'refresh-accounts': true,
}

/** 語彙の集合。定義表から導出し、二重定義を作らない。 */
const ALLOWED_JOB_SET: ReadonlySet<string> = new Set(Object.keys(ALLOWED_JOBS))

/** 入力に含めてよいフィールド。これ以外のフィールドを持つ入力は拒否する（余剰フィールドの拒否）。 */
const ALLOWED_FIELDS: ReadonlySet<string> = new Set(['job', 'attempt'])

/** attempt の範囲（1 起点）。初回込み最大 3 試行の採番は実行基盤（再試行制御）の責務とする。 */
const FIRST_ATTEMPT = 1
const LAST_ATTEMPT = 3

/** 受理した Job の実行内容。入力の値はここで確定した語彙・範囲のものだけになる。 */
export interface JobInvocation {
  readonly job: JobName
  /** 1 起点の試行番号。省略時は初回（1）。 */
  readonly attempt: number
}

/** 入力がオブジェクト（配列以外）かを判定する。プリミティブ・null・配列は Job の入力ではない。 */
const isInputObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 値が許可 Job の語彙に含まれるかを判定する（実行時の値の検証）。 */
const isAllowedJobName = (value: unknown): value is JobName =>
  typeof value === 'string' && ALLOWED_JOB_SET.has(value)

/**
 * own property の値だけを読む。継承フィールド（Object.create のプロトタイプや
 * Object.prototype 汚染）経由の値は読まない（余剰フィールド検査は own のキーしか見ないため、
 * 継承経由で実行内容へ値が混ざる経路をここで断つ）。
 */
const readOwnField = (input: Record<string, unknown>, field: string): unknown =>
  Object.hasOwn(input, field) ? input[field] : undefined

/** attempt が 1 起点の範囲内の整数かを判定する（文字列・小数・NaN・範囲外を弾く）。 */
const isAttempt = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= FIRST_ATTEMPT &&
  value <= LAST_ATTEMPT

/**
 * 拒否の結果を作る。分類（INVALID_JOB）だけを返し、入力の内容は結果へ含めない
 * （自由文字列を Domain Error へ持ち込まない）。
 */
const invalidJob = (): DomainError => createDomainError('INVALID_JOB')

/**
 * 入力を検証して実行内容へ振り分ける。
 * 受理するのは `{ job: 'refresh-accounts', attempt?: 1..3 }` の形だけとし、
 * 未知の Job・job の欠落・形式不正（型違い・小数・範囲外）・余剰フィールドは
 * すべて INVALID_JOB で拒否する（ADR-0010 の禁止例を受け付けない）。
 * job / attempt は own property の値だけを読み、継承フィールド経由の値は使わない。
 */
export const routeJob = (input: unknown): Result<JobInvocation> => {
  if (!isInputObject(input)) {
    return { ok: false, error: invalidJob() }
  }

  if (!Object.keys(input).every((field) => ALLOWED_FIELDS.has(field))) {
    return { ok: false, error: invalidJob() }
  }

  const job = readOwnField(input, 'job')
  if (!isAllowedJobName(job)) {
    return { ok: false, error: invalidJob() }
  }

  const attempt = readOwnField(input, 'attempt')
  // 明示的な undefined は省略と同じ扱いにする（JSON には現れないが、JS の呼び出しでは起こり得る）。
  if (attempt !== undefined && !isAttempt(attempt)) {
    return { ok: false, error: invalidJob() }
  }

  return { ok: true, value: { job, attempt: attempt ?? FIRST_ATTEMPT } }
}
