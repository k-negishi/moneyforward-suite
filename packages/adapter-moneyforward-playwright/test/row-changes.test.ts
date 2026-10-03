import { describe, expect, it } from 'vitest'

import {
  detectRefreshSignals,
  detectRowChanges,
  extractRefreshTimestampText,
  isRowSnapshotValid,
  normalizeText,
  ROW_REFRESH_SIGNAL_PROBES,
} from '../src/moneyforward/row-changes.js'

// 合成した文言のみを使う（本番の DOM / HTML は使わない）。
describe('normalizeText', () => {
  it('全角英数を半角へ正規化し、空白・改行を除去する', () => {
    expect(normalizeText('ＡＢＣ　Ｄｅｆ １２３')).toBe('ABCDef123')
  })
})

describe('extractRefreshTimestampText', () => {
  it('絶対日付（スラッシュ・ハイフン・日本語形式）を抽出する', () => {
    expect(extractRefreshTimestampText('口座A 更新日時 2026/10/01')).toBe('2026/10/01')
    expect(extractRefreshTimestampText('口座A 更新日時 2026-10-01')).toBe('2026-10-01')
    expect(extractRefreshTimestampText('口座A 更新日時 2026年10月1日')).toBe('2026年10月1日')
  })

  it('時刻を抽出する', () => {
    expect(extractRefreshTimestampText('口座A 更新日時 2026/10/01 12:34')).toBe('2026/10/01,12:34')
    expect(extractRefreshTimestampText('口座A 更新日時 12:34:56')).toBe('12:34:56')
  })

  it('相対時刻（たった今・N分前）は抽出しない（自然変動で偽受理になり得るため証拠から除外する）', () => {
    expect(extractRefreshTimestampText('口座A たった今 更新')).toBeNull()
    expect(extractRefreshTimestampText('口座A 5分前 更新')).toBeNull()
    expect(extractRefreshTimestampText('口座A 2時間前 更新')).toBeNull()
    expect(extractRefreshTimestampText('口座A 30秒前 更新')).toBeNull()
  })

  it('絶対日時と相対時刻が混在する場合は、絶対日時だけを抽出する', () => {
    expect(extractRefreshTimestampText('口座A 2026/10/01 5分前')).toBe('2026/10/01')
  })

  it('全角数字・空白混じりでも正規化して抽出する', () => {
    expect(extractRefreshTimestampText('口座A 更新日時 ２０２６／１０／０１')).toBe('2026/10/01')
    expect(extractRefreshTimestampText('口座A 更新日時\n2026/10/01 12:34')).toBe('2026/10/01,12:34')
  })

  it('日時らしき部分が無ければ null を返す', () => {
    expect(extractRefreshTimestampText('口座A 残高 1,234,567円 更新')).toBeNull()
    expect(extractRefreshTimestampText('')).toBeNull()
  })
})

describe('detectRefreshSignals', () => {
  it('進行中シグナルの一致有無を真偽値で返す', () => {
    const signals = detectRefreshSignals('ただいまデータを更新中です')
    expect(signals.inProgress).toBe(true)
    expect(signals.fetching).toBe(false)
  })

  it('取得中のシグナルも区別できる', () => {
    expect(detectRefreshSignals('データを取得中です').fetching).toBe(true)
    expect(detectRefreshSignals('データを取得中です').inProgress).toBe(false)
  })

  it('改行・連続空白を挟んだ文言も検出する', () => {
    expect(detectRefreshSignals('更新中\nです').inProgress).toBe(true)
  })

  it('失敗形でも一致自体は記録する（プローブは観測をそのまま返す）', () => {
    expect(detectRefreshSignals('更新中にエラーが発生しました').inProgress).toBe(true)
  })

  it('プローブは受付判定に必要な進行中系の最小限のみ（実機では「更新中」の出現を確認済み）', () => {
    expect(
      ROW_REFRESH_SIGNAL_PROBES.map(([key]) => key).sort((a, b) => a.localeCompare(b)),
    ).toEqual(['fetching', 'inProgress'])
  })

  it('対象外の文言ではすべて false を返す', () => {
    expect(Object.values(detectRefreshSignals('口座A 更新日時 2026/10/01')).every((v) => !v)).toBe(
      true,
    )
    expect(Object.values(detectRefreshSignals('')).every((v) => !v)).toBe(true)
  })
})

describe('detectRowChanges', () => {
  const beforeRows = ['口座A 更新日時 2026/10/01 更新', '口座B 更新日時 2026/10/01 更新']

  it('変化が無ければ changedCount=0・出現なし・失敗なし', () => {
    expect(detectRowChanges(beforeRows, [...beforeRows])).toEqual({
      valid: true,
      changedCount: 0,
      inProgressAppeared: false,
      failedCount: 0,
    })
  })

  it('更新日時らしき部分が変化した行を changedCount に数える', () => {
    const afterRows = ['口座A 更新日時 2026/10/03 更新', '口座B 更新日時 2026/10/01 更新']
    expect(detectRowChanges(beforeRows, afterRows)).toEqual({
      valid: true,
      changedCount: 1,
      inProgressAppeared: false,
      failedCount: 0,
    })
  })

  it('日時らしき部分の無い行のテキスト変化は changedCount に数えない（不一致な変化を受理と誤認しない）', () => {
    const before = ['口座A 更新', '口座B 更新日時 2026/10/01 更新']
    const after = ['口座A 再読み込みされました', '口座B 更新日時 2026/10/01 更新']
    expect(detectRowChanges(before, after).changedCount).toBe(0)
  })

  it('相対時刻だけが変わった行は changedCount に数えない（自然変動を反応と誤認しない）', () => {
    const before = ['口座A 更新日時 5分前 更新']
    const after = ['口座A 更新日時 4分前 更新']
    expect(detectRowChanges(before, after).changedCount).toBe(0)
  })

  it('クリック前は日時なし・クリック後に日時が現れた行も changedCount に数えない（片側だけでは比較できない）', () => {
    const before = ['口座A 更新']
    const after = ['口座A 更新日時 2026/10/03 更新']
    expect(detectRowChanges(before, after).changedCount).toBe(0)
  })

  it('進行中シグナルが新規出現したら inProgressAppeared=true', () => {
    const before = ['口座A 更新', '口座B 更新日時 2026/10/01 更新']
    const after = ['口座A 更新中', '口座B 更新日時 2026/10/01 更新']
    expect(detectRowChanges(before, after)).toEqual({
      valid: true,
      changedCount: 0,
      inProgressAppeared: true,
      failedCount: 0,
    })
  })

  it('クリック前から進行中シグナルがある行は出現としない（常設文言を反応と誤認しない）', () => {
    const before = ['口座A 更新中', '口座B 更新日時 2026/10/01 更新']
    const after = ['口座A 更新中です', '口座B 更新日時 2026/10/01 更新']
    expect(detectRowChanges(before, after)).toEqual({
      valid: true,
      changedCount: 0,
      inProgressAppeared: false,
      failedCount: 0,
    })
  })

  it('行数が増えた観測は対応付けの破綻として無効（valid=false）とする', () => {
    const afterRows = [...beforeRows, '口座C 更新日時 2026/10/03 更新']
    expect(detectRowChanges(beforeRows, afterRows)).toEqual({
      valid: false,
      changedCount: 0,
      inProgressAppeared: false,
      failedCount: 0,
    })
  })

  it('進行中シグナルのある行が追加されても、行数が増えた観測は証拠にしない（fail closed）', () => {
    expect(detectRowChanges(['口座A 更新'], ['口座A 更新', '口座B 更新中']).valid).toBe(false)
  })

  it('行数が減った観測は無効（valid=false）とし、変化として扱わない', () => {
    expect(detectRowChanges(beforeRows, [beforeRows[0] ?? ''])).toEqual({
      valid: false,
      changedCount: 0,
      inProgressAppeared: false,
      failedCount: 0,
    })
  })

  it('クリック後に 0 件になった観測も無効（valid=false）とする', () => {
    expect(detectRowChanges(beforeRows, [])).toEqual({
      valid: false,
      changedCount: 0,
      inProgressAppeared: false,
      failedCount: 0,
    })
  })

  it('空白・改行だけの差分は変化としない（正規化して比較する）', () => {
    const afterRows = ['口座A 更新日時  2026/10/01\n更新', '口座B 更新日時 2026/10/01 更新']
    expect(detectRowChanges(beforeRows, afterRows).changedCount).toBe(0)
  })

  it('一部の行の失敗と別の行の日時変化は独立に数える（一部成功・一部失敗を潰さない）', () => {
    const afterRows = ['口座A 更新中にエラーが発生しました', '口座B 更新日時 2026/10/03 更新']
    expect(detectRowChanges(beforeRows, afterRows)).toEqual({
      valid: true,
      changedCount: 1,
      inProgressAppeared: false,
      failedCount: 1,
    })
  })

  it('失敗が現れた行の進行中シグナルは出現と数えない（失敗文言の文字列を誤認しない）', () => {
    const afterRows = ['口座A 更新中にエラーが発生しました', '口座B 更新日時 2026/10/01 更新']
    const evidence = detectRowChanges(beforeRows, afterRows)
    expect(evidence.inProgressAppeared).toBe(false)
    expect(evidence.changedCount).toBe(0)
    expect(evidence.failedCount).toBe(1)
  })

  it('否定形（できませんでした）が出現した場合も失敗として数え、受付の証拠にはしない', () => {
    const afterRows = ['口座A 更新できませんでした', '口座B 更新日時 2026/10/01 更新']
    const evidence = detectRowChanges(beforeRows, afterRows)
    expect(evidence.failedCount).toBe(1)
    expect(evidence.inProgressAppeared).toBe(false)
    expect(evidence.changedCount).toBe(0)
  })

  it('クリック前から失敗表示の行が常設されていても、変化が無ければ failedCount は 0 のまま', () => {
    const before = ['口座A 更新できませんでした', '口座B 更新日時 2026/10/01 更新']
    expect(detectRowChanges(before, [...before])).toEqual({
      valid: true,
      changedCount: 0,
      inProgressAppeared: false,
      failedCount: 0,
    })
  })

  it('同じ行に別の失敗マーカーが新しく現れたら failedCount=1（マーカー単位で判定する）', () => {
    const before = ['口座A 更新に失敗しました']
    const after = ['口座A 更新に失敗しました エラーが発生しました']

    expect(detectRowChanges(before, after).failedCount).toBe(1)
  })

  it('クリック前後で同じ失敗マーカーだけの行は failedCount=0（常設の失敗表示を反応としない）', () => {
    const before = ['口座A 更新に失敗しました']
    const after = ['口座A 更新に失敗しました']

    const evidence = detectRowChanges(before, after)
    expect(evidence.failedCount).toBe(0)
    expect(evidence.changedCount).toBe(0)
  })

  it('常設の失敗行があっても、他の行の日時変化は受付の根拠として維持する', () => {
    const before = ['口座A 更新できませんでした', '口座B 更新日時 2026/10/01 更新']
    const after = ['口座A 更新できませんでした', '口座B 更新日時 2026/10/03 更新']
    expect(detectRowChanges(before, after)).toEqual({
      valid: true,
      changedCount: 1,
      inProgressAppeared: false,
      failedCount: 0,
    })
  })

  it('クリック前から失敗表示の行は、日時が変化しても changedCount に寄与しない', () => {
    const before = ['口座A 更新に失敗しました 2026/10/01']
    const after = ['口座A 更新に失敗しました 2026/10/03']

    const evidence = detectRowChanges(before, after)
    expect(evidence.changedCount).toBe(0)
    expect(evidence.failedCount).toBe(0)
  })

  it('クリック前から失敗表示の行に進行中シグナルが現れても受付の根拠にしない', () => {
    const before = ['口座A 更新に失敗しました']
    const after = ['口座A 更新に失敗しました 更新中']

    const evidence = detectRowChanges(before, after)
    expect(evidence.changedCount).toBe(0)
    expect(evidence.inProgressAppeared).toBe(false)
  })

  it('失敗行を除外しても、非失敗行の変化だけで受付の根拠になる', () => {
    const before = ['口座A 更新に失敗しました', '口座B 更新日時 2026/10/01 更新']
    const after = ['口座A 更新に失敗しました（再試行）', '口座B 更新日時 2026/10/03 更新']

    const evidence = detectRowChanges(before, after)
    expect(evidence.changedCount).toBe(1)
    expect(evidence.failedCount).toBe(0)
  })

  it('行が成功表示から失敗表示に変わったら failedCount=1', () => {
    const before = ['口座A 更新日時 2026/10/01 更新']
    const after = ['口座A 取得に失敗しました']
    expect(detectRowChanges(before, after)).toEqual({
      valid: true,
      changedCount: 0,
      inProgressAppeared: false,
      failedCount: 1,
    })
  })

  it('行数が増えた観測では、増えた行の失敗も判定に使わない（対応付けの破綻として無効）', () => {
    const evidence = detectRowChanges(
      ['口座A 更新日時 2026/10/01 更新'],
      ['口座A 更新日時 2026/10/01 更新', '口座B 更新に失敗しました'],
    )
    expect(evidence.valid).toBe(false)
    expect(evidence.failedCount).toBe(0)
  })

  it('不安定な行（null）は日時が変化していても changedCount に数えない（自然変動を反応と誤認しない）', () => {
    // クリック前に 2 回観測しても一致しなかった行は null で渡される。
    const before = [null, '口座B 更新日時 2026/10/01 更新']
    const after = ['口座A 更新日時 2026/10/03 更新', '口座B 更新日時 2026/10/01 更新']
    expect(detectRowChanges(before, after)).toEqual({
      valid: true,
      changedCount: 0,
      inProgressAppeared: false,
      failedCount: 0,
    })
  })

  it('不安定な行（null）に進行中シグナルが現れても出現としない', () => {
    const before = [null]
    const after = ['口座A 更新中']
    expect(detectRowChanges(before, after).inProgressAppeared).toBe(false)
  })

  it('不安定な行（null）に失敗の文言が現れた場合は失敗として扱う（fail closed）', () => {
    const before = [null, '口座B 更新日時 2026/10/01 更新']
    const after = ['口座A 更新できませんでした', '口座B 更新日時 2026/10/01 更新']
    expect(detectRowChanges(before, after).failedCount).toBe(1)
  })

  it('全行が不安定（null）の場合は受付の証拠に数えない', () => {
    expect(
      detectRowChanges([null, null], ['口座A 更新日時 2026/10/03 更新', '口座B 更新中']),
    ).toEqual({
      valid: true,
      changedCount: 0,
      inProgressAppeared: false,
      failedCount: 0,
    })
  })

  it('空文字の行を含む観測は無効（valid=false）とし、変化として扱わない', () => {
    // 再描画・デタッチ中に innerText が空になる状況を再現する（片側の行が空）。
    const afterRows = ['口座A 更新日時 2026/10/03 更新', '']
    expect(detectRowChanges(beforeRows, afterRows)).toEqual({
      valid: false,
      changedCount: 0,
      inProgressAppeared: false,
      failedCount: 0,
    })
  })

  it('クリック前のスナップショットに空文字の行がある場合も無効とする', () => {
    const before = ['口座A 更新日時 2026/10/01 更新', '']
    expect(detectRowChanges(before, beforeRows).valid).toBe(false)
  })

  it('空白のみの行も空文字と同じく無効とする', () => {
    expect(detectRowChanges(beforeRows, ['口座A 更新日時 2026/10/01 更新', '  \n']).valid).toBe(
      false,
    )
  })

  it('空文字が消えた観測に戻れば、有効な比較を再開する', () => {
    const detached = ['口座A 更新日時 2026/10/03 更新', '']
    expect(detectRowChanges(beforeRows, detached).valid).toBe(false)

    // 再描画が終わり、全行のテキストが取得できた観測は有効に戻る。
    const recovered = ['口座A 更新日時 2026/10/03 更新', '口座B 更新日時 2026/10/01 更新']
    expect(detectRowChanges(beforeRows, recovered)).toEqual({
      valid: true,
      changedCount: 1,
      inProgressAppeared: false,
      failedCount: 0,
    })
  })

  it('空の行リストは観測の前提を満たさず無効（valid=false）とする', () => {
    expect(detectRowChanges([], [])).toEqual({
      valid: false,
      changedCount: 0,
      inProgressAppeared: false,
      failedCount: 0,
    })
  })
})

describe('isRowSnapshotValid', () => {
  it('全行にテキストがあれば有効とする', () => {
    expect(isRowSnapshotValid(['口座A 更新', '口座B 更新'])).toBe(true)
  })

  it('空文字・空白のみの行を含む場合は無効とする', () => {
    expect(isRowSnapshotValid(['口座A 更新', ''])).toBe(false)
    expect(isRowSnapshotValid(['口座A 更新', '  \n'])).toBe(false)
  })

  it('空のリストは無効とする（比較の基準にしない）', () => {
    expect(isRowSnapshotValid([])).toBe(false)
  })
})
