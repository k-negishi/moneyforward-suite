import { describe, expect, it } from 'vitest'

import {
  ROW_REFRESH_SIGNAL_PROBES,
  detectRefreshSignals,
  detectRowChanges,
  isRowSnapshotValid,
  normalizeText,
} from '../src/moneyforward/row-changes.js'

// 合成した文言のみを使う（本番の DOM / HTML は使わない）。
describe('normalizeText', () => {
  it('全角英数を半角へ正規化し、空白・改行を除去する', () => {
    expect(normalizeText('ＡＢＣ　Ｄｅｆ １２３')).toBe('ABCDef123')
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
    expect(ROW_REFRESH_SIGNAL_PROBES.map(([key]) => key).sort()).toEqual([
      'fetching',
      'inProgress',
    ])
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
      failureDetected: false,
    })
  })

  it('いずれかの行のテキストが変化したら changedCount に数える', () => {
    const afterRows = ['口座A 更新日時 2026/10/03 更新', '口座B 更新日時 2026/10/01 更新']
    expect(detectRowChanges(beforeRows, afterRows)).toEqual({
      valid: true,
      changedCount: 1,
      inProgressAppeared: false,
      failureDetected: false,
    })
  })

  it('進行中シグナルが新規出現したら inProgressAppeared=true', () => {
    const afterRows = ['口座A 更新中', '口座B 更新日時 2026/10/01 更新']
    expect(detectRowChanges(beforeRows, afterRows)).toEqual({
      valid: true,
      changedCount: 1,
      inProgressAppeared: true,
      failureDetected: false,
    })
  })

  it('クリック前から進行中シグナルがある行は出現としない（常設文言を反応と誤認しない）', () => {
    const before = ['口座A 更新中', '口座B 更新日時 2026/10/01 更新']
    const after = ['口座A 更新中です', '口座B 更新日時 2026/10/01 更新']
    expect(detectRowChanges(before, after)).toEqual({
      valid: true,
      changedCount: 1,
      inProgressAppeared: false,
      failureDetected: false,
    })
  })

  it('行数が増えた分は変化として数える', () => {
    const afterRows = [...beforeRows, '口座C 更新日時 2026/10/03 更新']
    const evidence = detectRowChanges(beforeRows, afterRows)
    expect(evidence.changedCount).toBe(1)
    expect(evidence.failureDetected).toBe(false)
  })

  it('行数が減った観測は無効（valid=false）とし、変化として扱わない', () => {
    expect(detectRowChanges(beforeRows, [beforeRows[0] ?? ''])).toEqual({
      valid: false,
      changedCount: 0,
      inProgressAppeared: false,
      failureDetected: false,
    })
  })

  it('クリック後に 0 件になった観測も無効（valid=false）とする', () => {
    expect(detectRowChanges(beforeRows, [])).toEqual({
      valid: false,
      changedCount: 0,
      inProgressAppeared: false,
      failureDetected: false,
    })
  })

  it('空白・改行だけの差分は変化としない（正規化して比較する）', () => {
    const afterRows = ['口座A 更新日時  2026/10/01\n更新', '口座B 更新日時 2026/10/01 更新']
    expect(detectRowChanges(beforeRows, afterRows).changedCount).toBe(0)
  })

  it('クリック後に失敗が出現したら failureDetected=true（受付の根拠にしない）', () => {
    const afterRows = ['口座A 更新中にエラーが発生しました', '口座B 更新日時 2026/10/03 更新']
    expect(detectRowChanges(beforeRows, afterRows)).toEqual({
      valid: true,
      changedCount: 0,
      inProgressAppeared: false,
      failureDetected: true,
    })
  })

  it('否定形（できませんでした）が出現した場合も失敗として扱い、受付と誤認しない', () => {
    const afterRows = ['口座A 更新できませんでした', '口座B 更新日時 2026/10/01 更新']
    const evidence = detectRowChanges(beforeRows, afterRows)
    expect(evidence.failureDetected).toBe(true)
    expect(evidence.inProgressAppeared).toBe(false)
    expect(evidence.changedCount).toBe(0)
  })

  it('クリック前から失敗表示の行が常設されていても、変化が無ければ failureDetected にならない', () => {
    const before = ['口座A 更新できませんでした', '口座B 更新日時 2026/10/01 更新']
    expect(detectRowChanges(before, [...before])).toEqual({
      valid: true,
      changedCount: 0,
      inProgressAppeared: false,
      failureDetected: false,
    })
  })

  it('同じ行に別の失敗マーカーが新しく現れたら failureDetected=true（マーカー単位で判定する）', () => {
    const before = ['口座A 更新に失敗しました']
    const after = ['口座A 更新に失敗しました エラーが発生しました']

    expect(detectRowChanges(before, after).failureDetected).toBe(true)
  })

  it('クリック前後で同じ失敗マーカーだけの行は failureDetected=false（常設の失敗表示を反応としない）', () => {
    const before = ['口座A 更新に失敗しました']
    const after = ['口座A 更新に失敗しました']

    const evidence = detectRowChanges(before, after)
    expect(evidence.failureDetected).toBe(false)
    expect(evidence.changedCount).toBe(0)
  })

  it('常設の失敗行があっても、他の行の変化は受付の根拠として維持する', () => {
    const before = ['口座A 更新できませんでした', '口座B 更新日時 2026/10/01 更新']
    const after = ['口座A 更新できませんでした', '口座B 更新日時 2026/10/03 更新']
    expect(detectRowChanges(before, after)).toEqual({
      valid: true,
      changedCount: 1,
      inProgressAppeared: false,
      failureDetected: false,
    })
  })

  it('クリック前から失敗表示の行は、文言が変化しても changedCount に寄与しない', () => {
    const before = ['口座A 更新に失敗しました']
    const after = ['口座A 更新に失敗しました（再試行）']

    const evidence = detectRowChanges(before, after)
    expect(evidence.changedCount).toBe(0)
    expect(evidence.failureDetected).toBe(false)
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
    expect(evidence.failureDetected).toBe(false)
  })

  it('行が成功表示から失敗表示に変わったら failureDetected=true', () => {
    const before = ['口座A 更新日時 2026/10/01 更新']
    const after = ['口座A 取得に失敗しました']
    expect(detectRowChanges(before, after)).toEqual({
      valid: true,
      changedCount: 0,
      inProgressAppeared: false,
      failureDetected: true,
    })
  })

  it('新規行に失敗が現れた場合も出現として failureDetected=true', () => {
    const evidence = detectRowChanges(
      ['口座A 更新日時 2026/10/01 更新'],
      ['口座A 更新日時 2026/10/01 更新', '口座B 更新に失敗しました'],
    )
    expect(evidence.failureDetected).toBe(true)
    expect(evidence.changedCount).toBe(0)
  })

  it('空文字の行を含む観測は無効（valid=false）とし、変化として扱わない', () => {
    // 再描画・デタッチ中に innerText が空になる状況を再現する（片側の行が空）。
    const afterRows = ['口座A 更新日時 2026/10/03 更新', '']
    expect(detectRowChanges(beforeRows, afterRows)).toEqual({
      valid: false,
      changedCount: 0,
      inProgressAppeared: false,
      failureDetected: false,
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
      failureDetected: false,
    })
  })

  it('空の行リストは観測の前提を満たさず無効（valid=false）とする', () => {
    expect(detectRowChanges([], [])).toEqual({
      valid: false,
      changedCount: 0,
      inProgressAppeared: false,
      failureDetected: false,
    })
  })

  it('進行中シグナルのある行が追加された場合は出現として扱う', () => {
    const evidence = detectRowChanges(['口座A 更新'], ['口座A 更新', '口座B 更新中'])
    expect(evidence.inProgressAppeared).toBe(true)
    expect(evidence.changedCount).toBe(1)
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
