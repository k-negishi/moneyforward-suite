import { isAuthChallengeDetected } from './config.js'

/**
 * spike CLI の判定に使う純関数（行変化と認証状態の分類）。
 * 実機では一括更新は行ごとに処理され、メッセージ・ページ遷移は無く、行のスピナー表示と
 * 更新日時の変化で確認できる。そのため行のテキスト変化と、進行中シグナルの新規出現で受付を判定する。
 * プローブや文言が実機と合わない場合は変化なしとして扱い、呼び出し側が停止する（fail closed）。
 * 成功判定はクリックできたかではなく状態変化で行う（ADR-0020）。
 */

/**
 * 全角英数を半角へ正規化し、空白・改行を除去する。
 * 日本語の文言は画面幅で折り返され得るため、空白を挟んでもパターンが一致するようにする。
 * 行内テキストの前後比較にも使う（空白だけの差分を変化とみなさない）。
 */
export const normalizeText = (text: string): string => text.normalize('NFKC').replace(/\s+/gu, '')

/**
 * 失敗・否定を示す文言の暫定パターン。クリック後に新しく現れたマーカーがあれば
 * 成功と判定しない（fail closed）。「更新の受付が完了しませんでした」「更新中にエラーが
 * 発生しました」のような文を、受付・進行中のシグナルと誤認しないよう、判定より先に評価する。
 * 比較はマーカー単位で行い、行に前からある失敗表示は出現とみなさない。
 * 実機の文言を確認したらこの配列だけを差し替える。
 */
const FAILURE_PATTERNS: readonly RegExp[] = [
  /できませんでした/,
  /しませんでした/,
  /失敗/,
  /エラー/,
  /中断/,
  /キャンセル/,
]

/** 失敗・否定の文言を含むか（正規化済みテキストに対して評価する）。 */
const containsFailureMarker = (normalizedText: string): boolean =>
  FAILURE_PATTERNS.some((pattern) => pattern.test(normalizedText))

/**
 * 行の進行中シグナルのプローブ（受付判定に必要な最小限）。
 * 受付は「クリック後にだけ現れた」出現ベースで判定する（クリック前から表示されている
 * 常設の案内文を反応と誤認しないため）。文言は出力せず、真偽値のみを使う。
 * 実機では「更新中」の新規出現で受付を確認している。
 */
export const ROW_REFRESH_SIGNAL_PROBES: ReadonlyArray<readonly [string, string]> = [
  ['inProgress', '更新中'],
  ['fetching', '取得中'],
]

/**
 * プローブの一致有無を返す（テキストは返さず真偽値のみ）。
 * 失敗・否定形の除外はしない（失敗の判定は detectRowChanges が行う）。
 */
export const detectRefreshSignals = (text: string): Readonly<Record<string, boolean>> => {
  const normalized = normalizeText(text)
  const signals: Record<string, boolean> = {}
  for (const [key, marker] of ROW_REFRESH_SIGNAL_PROBES) {
    signals[key] = normalized.includes(marker)
  }
  return signals
}

/** 進行中シグナルが 1 つでも一致するか（プローブは進行中系のみを登録している）。 */
const hasInProgressSignal = (text: string): boolean =>
  Object.values(detectRefreshSignals(text)).some((value) => value)

/** 行の変化検出の結果（件数と真偽値のみ。行テキストは返さない）。 */
export interface RowChangeEvidence {
  readonly valid: boolean // 空文字の行を含まない有効な観測か（false は受付の判定に使わない）
  readonly changedCount: number // クリック前後でテキストが変化した行数（行数の増減を含む）
  readonly inProgressAppeared: boolean // 進行中シグナルが新規出現した行があるか
  readonly failureDetected: boolean // クリック後に失敗・否定形が出現したか
}

/** 行テキストに空（空白のみを含む）の行があるか。再描画・デタッチ中の観測を無効とするために使う。 */
const hasEmptyRow = (rows: readonly string[]): boolean =>
  rows.some((row) => normalizeText(row).length === 0)

/**
 * 行テキストのスナップショットが観測として有効か（空でなく、空文字の行を含まないか）。
 * 再描画・デタッチ中のスナップショットを比較の基準に使わないため、呼び出し側が確認する。
 */
export const isRowSnapshotValid = (rows: readonly string[]): boolean =>
  rows.length > 0 && !hasEmptyRow(rows)

/**
 * クリック前後の行テキストを比較し、変化・進行中シグナルの出現・失敗文言の出現を判定する（純関数）。
 * 行は index で対応付ける（実機では一括更新中も行の並びは安定している）。行数の増加は
 * 新しく現れた行として変化に数える。行数の減少・0 件は再描画・デタッチによる行の欠落と
 * みなして無効な観測とする。失敗・否定形はマーカー単位で「クリック後にだけ現れた」場合のみ
 * 失敗として扱う（実機では認証失敗が残った口座など、クリック前から失敗表示の行が常設されるため。
 * 行に前からある失敗表示をクリックへの反応と誤認しない）。失敗の出現を検知した場合は
 * 変化・出現の根拠にしない（fail closed）。空文字の行を含む観測（再描画・デタッチ中）は
 * 比較の前提を満たさないため valid=false とし、呼び出し側は判定に使わない。
 * 制限: 行テキストが時間で自然変動する場合（更新日時の自動更新等）、差分ベースの判定が
 * 誤検知し得る。実機で自然変動の有無を要確認。
 * 戻り値は件数と真偽値のみで、テキストは返さない。
 */
export const detectRowChanges = (
  beforeRows: readonly string[],
  afterRows: readonly string[],
): RowChangeEvidence => {
  // どちらかのスナップショットに空文字の行があれば、その観測を無効として判定しない（fail closed）。
  if (hasEmptyRow(beforeRows) || hasEmptyRow(afterRows)) {
    return { valid: false, changedCount: 0, inProgressAppeared: false, failureDetected: false }
  }
  // クリック後に 0 件、または行数が減った観測は、再描画・デタッチによる行の欠落とみなし
  // 無効として判定しない（fail closed）。
  if (afterRows.length === 0 || afterRows.length < beforeRows.length) {
    return { valid: false, changedCount: 0, inProgressAppeared: false, failureDetected: false }
  }

  let changedCount = 0
  let inProgressAppeared = false
  let failureAppeared = false
  const maxLength = Math.max(beforeRows.length, afterRows.length)

  for (let index = 0; index < maxLength; index += 1) {
    const before = beforeRows[index]
    const after = afterRows[index]

    // 失敗はマーカー単位の出現ベースで判定する。クリック前の行に無かった失敗マーカーが
    // 現れた場合のみ失敗として扱い、行に前からある失敗表示を反応と誤認しない。
    // 新規行（行数の増加で現れた行）は、含まれるマーカーを出現として扱う。
    if (after !== undefined) {
      const afterNormalized = normalizeText(after)
      if (before === undefined) {
        if (containsFailureMarker(afterNormalized)) failureAppeared = true
      } else {
        const beforeNormalized = normalizeText(before)
        if (
          FAILURE_PATTERNS.some(
            (pattern) => pattern.test(afterNormalized) && !pattern.test(beforeNormalized),
          )
        ) {
          failureAppeared = true
        }
      }
    }

    // 行数の増加で新しく現れた行は変化として数える（減少は先頭で無効化している）。
    if (before === undefined || after === undefined) {
      changedCount += 1
      if (after !== undefined && hasInProgressSignal(after)) inProgressAppeared = true
      continue
    }

    if (normalizeText(before) !== normalizeText(after)) changedCount += 1
    if (!hasInProgressSignal(before) && hasInProgressSignal(after)) inProgressAppeared = true
  }

  // 失敗の出現を検知した場合は受付の根拠にしない（fail closed）。
  if (failureAppeared) {
    return { valid: true, changedCount: 0, inProgressAppeared: false, failureDetected: true }
  }
  return { valid: true, changedCount, inProgressAppeared, failureDetected: false }
}

/** 認証状態の分類に使う観測値（Page からの取得は呼び出し側で行う）。 */
export interface AuthStateSignals {
  readonly isSignInUrl: boolean
  readonly visibleText: string
  readonly visibleChallengeInputCount: number
}

/** 認証状態の三値。UNKNOWN は判定不能（本文取得失敗）を表し、呼び出し側が fail closed で扱う。 */
export type AuthState = 'AUTHENTICATED' | 'AUTH_REQUIRED' | 'UNKNOWN'

/**
 * 認証状態を分類する（純関数）。
 * sign_in へのリダイレクトと認証チャレンジの検知を AUTH_REQUIRED とする。
 * 本文テキストを取得できない場合は認証済みと見なさず、判定不能の UNKNOWN を返す（fail closed）。
 */
export const classifyAuthState = (signals: AuthStateSignals): AuthState => {
  // sign_in へのリダイレクトは、本文の取得可否によらず未認証と言い切れる。
  if (signals.isSignInUrl) return 'AUTH_REQUIRED'
  if (normalizeText(signals.visibleText).length === 0) return 'UNKNOWN'
  return isAuthChallengeDetected(signals) ? 'AUTH_REQUIRED' : 'AUTHENTICATED'
}
