/**
 * 行変化の判定に使う純関数。
 * 実機では一括更新は行ごとに処理され、メッセージ・ページ遷移は無く、行のスピナー表示と
 * 更新日時の変化で確認できる。そのため受付は「進行中シグナルの新規出現」または
 * 「絶対日時の変化」に限定して判定する。行全体の差分で判定すると、部分再描画・
 * 相対時刻の自然変動・クリック前スナップショット取得からクリック完了までの間の変化を
 * 反応と誤認し得るため、判定材料をこれらの証拠だけに絞る（fail closed）。
 * 失敗・否定形の出現は受付の証拠とは独立に行数で数え、受付の有無は正の証拠だけで判定する
 * （一部成功・一部失敗を拒否へ潰さず、総合的な判定は core の写像に委ねる）。
 * プローブや文言が実機と合わない場合は受付の証拠が無いものとして扱い、呼び出し側が
 * NOT_ACCEPTED として停止する。成功判定はクリックできたかではなく状態変化で行う（ADR-0020）。
 */

/**
 * 全角英数を半角へ正規化し、空白・改行を除去する。
 * 日本語の文言は画面幅で折り返され得るため、空白を挟んでもパターンが一致するようにする。
 * 行内テキストの前後比較にも使う（空白だけの差分を変化とみなさない）。
 */
export const normalizeText = (text: string): string => text.normalize('NFKC').replace(/\s+/gu, '')

/**
 * 更新日時らしき部分の暫定パターン（正規化済み・空白除去後のテキストに評価する）。
 * 受付の証拠は絶対日時（日付・時刻）の変化に限定する。相対時刻（たった今・N秒前 等）は
 * 時間経過だけで変わり、自然変動をクリックへの反応と誤認し得るため含めない
 * （実機で相対時刻の表示形式を確認したうえで、再導入するかを判断する）。
 * 実機の表示形式を確認したらこの配列だけを差し替える。
 */
const REFRESH_TIMESTAMP_PATTERNS: readonly RegExp[] = [
  /\d{4}[/\-年]\d{1,2}[/\-月]\d{1,2}日?/gu, // 絶対日付（2026/10/03・2026-10-03・2026年10月3日）
  /\d{1,2}:\d{2}(?::\d{2})?/gu, // 時刻（12:34・12:34:56）
]

/**
 * 行テキストから絶対日時らしき部分だけを抽出する（見つからなければ null）。
 * 受付の判定は行全体の差分ではなく、この抽出結果の変化に限定する（口座名の再描画や
 * 金額の更新など、クリックへの反応でない変化を受理と誤認しないため）。
 * 制限: 相対時刻のみを表示する行では日時を抽出できず、変化を検知できない。検知できない
 * 変化は受付の証拠が無いものとして NOT_ACCEPTED 側へ倒れる（成功とは判定しない。fail closed）。
 */
export const extractRefreshTimestampText = (text: string): string | null => {
  const normalized = normalizeText(text)
  const parts = REFRESH_TIMESTAMP_PATTERNS.flatMap((pattern) => normalized.match(pattern) ?? [])
  return parts.length > 0 ? parts.join(',') : null
}

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
  readonly valid: boolean // 空文字の行を含まず、行数も一致する有効な観測か（false は受付の判定に使わない）
  readonly changedCount: number // 絶対日時らしき部分が変化した行数（行全体の差分では数えない）
  readonly inProgressAppeared: boolean // 進行中シグナルが新規出現した行があるか
  readonly failedCount: number // クリック後に失敗・否定形が新規出現した行数（受付の判定とは独立に数える）
}

/** 行テキストに空（空白のみを含む）の行があるか。再描画・デタッチ中の観測を無効とするために使う。 */
const hasEmptyRow = (rows: readonly (string | null)[]): boolean =>
  rows.some((row) => row !== null && normalizeText(row).length === 0)

/**
 * 行テキストのスナップショットが観測として有効か（空でなく、空文字の行を含まないか）。
 * 再描画・デタッチ中のスナップショットを比較の基準に使わないため、呼び出し側が確認する。
 */
export const isRowSnapshotValid = (rows: readonly string[]): boolean =>
  rows.length > 0 && !hasEmptyRow(rows)

/** 無効な観測を表す結果（受付の判定に使わない）。 */
const invalidEvidence = (): RowChangeEvidence => ({
  valid: false,
  changedCount: 0,
  inProgressAppeared: false,
  failedCount: 0,
})

/** 1 行分の比較結果（件数と真偽値のみ。行テキストは返さない）。 */
interface RowDelta {
  readonly changed: boolean
  readonly inProgressAppeared: boolean
  readonly failed: boolean
}

/**
 * 1 行分の受付の証拠（絶対日時の変化・進行中シグナルの新規出現）と失敗の出現を比べる（純関数）。
 * クリック前が不安定な行（null）は比較の基準にできず、失敗の出現も断定できないため、
 * 失敗の文言があれば安全側に倒して失敗として数える（fail closed）。
 * 失敗が新しく現れた行と、クリック前から失敗表示の行は、変化・進行中シグナルを正の証拠に
 * 数えない（「更新中にエラーが発生しました」のような失敗文言に含まれる進行中シグナルの
 * 文字列を反応と誤認しない）。他の行の証拠は独立に数える（部分成功を取り逃さない）。
 */
const compareRow = (before: string | null, after: string): RowDelta => {
  const afterNormalized = normalizeText(after)
  if (before === null) {
    return {
      changed: false,
      inProgressAppeared: false,
      failed: containsFailureMarker(afterNormalized),
    }
  }

  const beforeNormalized = normalizeText(before)
  const failureAppeared = FAILURE_PATTERNS.some(
    (pattern) => pattern.test(afterNormalized) && !pattern.test(beforeNormalized),
  )
  if (failureAppeared || containsFailureMarker(beforeNormalized)) {
    return { changed: false, inProgressAppeared: false, failed: failureAppeared }
  }

  const beforeTimestamp = extractRefreshTimestampText(before)
  const afterTimestamp = extractRefreshTimestampText(after)
  return {
    changed:
      beforeTimestamp !== null && afterTimestamp !== null && beforeTimestamp !== afterTimestamp,
    inProgressAppeared: !hasInProgressSignal(before) && hasInProgressSignal(after),
    failed: false,
  }
}

/**
 * クリック前後の行テキストを比較し、受付の証拠（絶対日時の変化・進行中シグナルの新規出現）と
 * 失敗文言の出現を判定する（純関数）。変化と失敗は独立に行数で数え、片方でもう片方を潰さない
 * （一部成功・一部失敗の観測を部分成功の判定へ渡すため。総合的な判定は core の写像が行う）。
 * 行は index で対応付ける。実機検証では一括更新中も行の並びは安定していたが、行数の増減は
 * 並びのずれを伴い得るため（別の口座の日時と比較して変化と誤認し得る）、行数が一致しない
 * 観測は対応付けの破綻として無効にする（既知の前提: 一括更新中は行の並びと件数が安定している
 * こと。増減を許すには、実機で口座の同一性に基づく対応付けを確認してからにする）。
 * 空文字の行を含む観測（再描画・デタッチ中）も比較の前提を満たさないため無効とする。
 * 戻り値は件数と真偽値のみで、テキストは返さない。
 */
export const detectRowChanges = (
  beforeRows: readonly (string | null)[],
  afterRows: readonly string[],
): RowChangeEvidence => {
  // どちらかのスナップショットに空文字の行があれば、その観測を無効として判定しない（fail closed）。
  if (hasEmptyRow(beforeRows) || hasEmptyRow(afterRows)) {
    return invalidEvidence()
  }
  // クリック後に 0 件、または行数が一致しない観測（再描画・デタッチによる増減）は、
  // index の対応付けが崩れているため無効として判定しない（fail closed）。
  if (beforeRows.length === 0 || afterRows.length !== beforeRows.length) {
    return invalidEvidence()
  }

  let changedCount = 0
  let inProgressAppeared = false
  let failedCount = 0

  for (let index = 0; index < beforeRows.length; index += 1) {
    const before = beforeRows[index]
    const after = afterRows[index]
    // 行数の一致を確認済みのため通常は到達しない（型の絞り込みのための防御。fail closed）。
    if (before === undefined || after === undefined) {
      return invalidEvidence()
    }

    const delta = compareRow(before, after)
    if (delta.changed) {
      changedCount += 1
    }
    if (delta.inProgressAppeared) {
      inProgressAppeared = true
    }
    if (delta.failed) {
      failedCount += 1
    }
  }

  return { valid: true, changedCount, inProgressAppeared, failedCount }
}
