import { execFileSync } from 'node:child_process'
import { randomInt } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * noSecrets（entropyThreshold 63）の閾値の前提を固定するテスト。
 *
 * 背景: 既定の 41 では日本語の説明文を大量に誤検出するため、リポジトリでは 63 へ引き上げている
 * （60 でも日本語のテスト名を 2 件誤検出したため）。このテストは、その値で「パターン一致の
 * Secret 形式の値は検出され、日本語の説明文は検出されない」ことを固定し、閾値の変更時に
 * 誤検出件数の再測定を強制する。
 * 実際の値は実行時に生成し、固定の Secret 風文字列をリポジトリへ書かない
 * （Public リポジトリのため。実在しそうな固定文字列を残さない）。
 */
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/** 実行時に使う biome バイナリ（リポジトリの devDependencies と同一）。 */
const biomeBinary = join(repoRoot, 'node_modules', '.bin', 'biome')

/** リポジトリの biome 設定（entropyThreshold 63 を含む）。 */
const configPath = join(repoRoot, 'biome.jsonc')

/** AWS アクセスキー ID の本体（AKIA に続く部分）の長さ。 */
const AWS_KEY_BODY_LENGTH = 16

/** Slack トークンの ID 部・ランダム部の長さ。 */
const SLACK_ID_LENGTH = 12
const SLACK_SECRET_LENGTH = 24

/** Twilio API キーの 16 進数部の長さ。 */
const TWILIO_KEY_HEX_LENGTH = 32

/**
 * biome.jsonc から entropyThreshold の指定（キーと値の組）を取り出すパターン。
 * フォーマッタが options を 1 行に整形するため行頭アンカーは使えない。代わりに出現数を
 * 1 件に固定し、コメントなど設定以外の言及が混ざった場合も検出する。
 */
const ENTROPY_THRESHOLD_PATTERN = /"entropyThreshold"\s*:\s*(\d+)/g

/** 実行時に英数字の合成値を生成する（文字種は各形式の実値に合わせる）。 */
const randomFrom = (alphabet: string, length: number): string =>
  Array.from({ length }, () => alphabet.charAt(randomInt(alphabet.length))).join('')

const UPPERCASE_AND_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
// 長い 1 リテラルは noSecrets のエントロピー検知に拾われるため、2 つに分けて連結する。
const LOWERCASE = 'abcdefghijklmnopqrstuvwxyz'
const ALPHANUMERIC = UPPERCASE_AND_DIGITS + LOWERCASE
const DIGITS = '0123456789'
const LOWERCASE_HEX = '0123456789abcdef'

/** execFileSync が非 0 終了で投げるエラー（status / stdout / stderr を持つ）。 */
interface ExecFailure {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

const isExecFailure = (error: unknown): error is ExecFailure => {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  if (!('status' in error) || !('stdout' in error) || !('stderr' in error)) {
    return false
  }
  return (
    typeof error.status === 'number' &&
    typeof error.stdout === 'string' &&
    typeof error.stderr === 'string'
  )
}

/**
 * 一時ファイルを 1 つ作って noSecrets だけを実行し、終了コードと出力を返す。
 * 検出時は終了コードが非 0 になる（診断は error 固定）。一時ファイルは必ず削除する。
 */
const lintAsSecretProbe = (
  contents: string,
): { readonly status: number; readonly output: string } => {
  const directory = mkdtempSync(join(tmpdir(), 'mf-biome-no-secrets-'))
  try {
    const filePath = join(directory, 'sample.ts')
    writeFileSync(filePath, contents)
    const output = execFileSync(
      biomeBinary,
      [
        'lint',
        '--only=security/noSecrets',
        `--config-path=${configPath}`,
        // 一時ファイルはリポジトリの外に置くため、vcs 連携（.gitignore の参照）を無効にする。
        // 有効のままだと biome が「root 配下のパスではない」として異常終了する。
        '--vcs-enabled=false',
        filePath,
      ],
      // stderr を親へ継承させない（診断の生出力＝候補文字列をテストログへ流さない。捕捉は error 経由で行う）。
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    return { status: 0, output }
  } catch (error) {
    if (isExecFailure(error)) {
      return { status: error.status, output: `${error.stdout}${error.stderr}` }
    }
    throw error
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('noSecrets（entropyThreshold 63）の前提', () => {
  // biome の実行ファイルは Windows では biome.cmd になり、このテストは node_modules/.bin 直下の
  // 実行ファイルを前提にする。実行環境（CI は Linux）を単純に保つため、Windows では実行しない。
  const itUnlessWindows = it.skipIf(process.platform === 'win32')

  itUnlessWindows('AWS アクセスキー形式の合成値を検出する（パターン検出）', () => {
    const key = `AKIA${randomFrom(UPPERCASE_AND_DIGITS, AWS_KEY_BODY_LENGTH)}`
    const result = lintAsSecretProbe(`export const key = '${key}'\n`)

    expect(result.status).not.toBe(0)
    expect(result.output).toContain('noSecrets')
  })

  itUnlessWindows('Slack トークン形式・Twilio キー形式の合成値を検出する（パターン検出）', () => {
    const slackToken = [
      'xoxb',
      randomFrom(DIGITS, SLACK_ID_LENGTH),
      randomFrom(DIGITS, SLACK_ID_LENGTH),
      randomFrom(ALPHANUMERIC, SLACK_SECRET_LENGTH),
    ].join('-')
    const twilioKey = `SK${randomFrom(LOWERCASE_HEX, TWILIO_KEY_HEX_LENGTH)}`

    const result = lintAsSecretProbe(
      `export const slack = '${slackToken}'\nexport const twilio = '${twilioKey}'\n`,
    )

    expect(result.status).not.toBe(0)
    expect(result.output).toContain('noSecrets')
  })

  itUnlessWindows('日本語の説明文は検出しない（誤検出の抑制）', () => {
    const message =
      'プローブは受付判定に必要な進行中系の最小限のみ（実機では「更新中」の出現を確認済み）'
    // 閾値 62 以下では検出される（スコアが 6.2 超 6.3 以下）日本語のテスト名。閾値 63 の根拠として固定する。
    const borderline = '再試行可能な受付確認不能でも、Use Case 内部で再試行しない'
    const result = lintAsSecretProbe(
      `export const description = '${message}'\nexport const title = '${borderline}'\n`,
    )

    expect(result.status).toBe(0)
  })

  itUnlessWindows('閾値は 63 に固定されている（変更時は誤検出件数の再測定を強制する）', () => {
    // エントロピー検知パスはスコアが entropyThreshold / 10（63 なら 6.3）を超える場合だけ報告する。
    // 実測（20 回の生成で確認）では、ランダムな英数字トークンのスコアは閾値の前後に分布し、
    // 閾値 63 での検出は確率的になる（6/20。例: ghp_ + 36 文字）。つまり閾値 63 の検出の網は
    // 主にパターン一致（AWS キー・Slack・Twilio・URL パスワード等）であり、網を広げるには
    // 閾値を下げる変更（日本語の誤検出が現行ツリーで 55 なら 7 件・50 なら 95 件に増える）ではなく、
    // 専用の Secret スキャナーを使う。ここでは値そのものを固定し、変更を意図的にする。
    const source = readFileSync(configPath, 'utf8')
    const matches = [...source.matchAll(ENTROPY_THRESHOLD_PATTERN)]

    expect(
      matches,
      'biome.jsonc の entropyThreshold の指定が 1 件ではありません（設定の重複・コメント内の言及を確認してください）',
    ).toHaveLength(1)
    expect(Number(matches[0]?.[1])).toBe(63)
  })
})
