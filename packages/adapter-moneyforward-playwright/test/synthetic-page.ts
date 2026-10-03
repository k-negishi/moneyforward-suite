/**
 * テスト用の合成ページ（role ベースの DOM）。
 * すべてテスト用に合成した文言・構造で、本番の HTML / DOM・実データは使わない。
 */

/** 一括更新コントロールの表示名（実機と同じ文言を role=button で置く）。 */
export const BULK_UPDATE_LABEL = '金融機関からのデータ一括更新'

/** 口座行 1 件の合成 HTML。行内に「更新」ボタンを持たせ、実機と同じ role 構成にする。 */
export const accountRow = (label: string, updatedAt: string): string =>
  `<tr><td>${label}</td><td>残高 0円</td><td class="updated-at">更新日時 ${updatedAt}</td><td><button type="button">更新</button></td></tr>`

/** 合成ページの組み立てオプション。 */
export interface SyntheticPageOptions {
  readonly rows?: readonly string[]
  readonly bulk?: number
  readonly disabledBulk?: boolean
  readonly body?: string
  readonly script?: string
}

/** 合成ページの HTML。bulk の数だけ一括更新コントロールを置く（既定は 0 件）。 */
export const accountsHtml = (options: SyntheticPageOptions): string => {
  const bulkControls = Array.from(
    { length: options.bulk ?? 0 },
    () =>
      `<button type="button" data-bulk="true"${options.disabledBulk === true ? ' disabled' : ''}>${BULK_UPDATE_LABEL}</button>`,
  ).join('')
  const rows = (options.rows ?? []).join('')
  const script = options.script === undefined ? '' : `<script>${options.script}</script>`
  return [
    '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>合成ページ</title></head><body>',
    bulkControls,
    '<table><tbody>',
    rows,
    '</tbody></table>',
    options.body ?? '',
    script,
    '</body></html>',
  ].join('')
}

/** クリックで全行の更新日時を変える（受付の合成）。 */
export const CHANGE_TIMESTAMP_SCRIPT = `
  document.querySelector('[data-bulk="true"]').addEventListener('click', () => {
    document.querySelectorAll('td.updated-at').forEach((cell) => {
      cell.textContent = '更新日時 2026/10/04 12:00'
    })
  })
`

/** クリックで 1 行目を失敗文言に変える（拒否の合成）。 */
export const FAILURE_SCRIPT = `
  document.querySelector('[data-bulk="true"]').addEventListener('click', () => {
    document.querySelector('td.updated-at').textContent = '更新できませんでした'
  })
`

/** クリックで 1 行目を成功（日時変化）・2 行目を失敗文言に変える（一部成功・一部失敗の合成）。 */
export const PARTIAL_FAILURE_SCRIPT = `
  document.querySelector('[data-bulk="true"]').addEventListener('click', () => {
    const cells = document.querySelectorAll('td.updated-at')
    cells[0].textContent = '更新日時 2026/10/04 12:00'
    cells[1].textContent = '更新できませんでした'
  })
`

/** クリックでパスワード入力欄を出す（認証失効の合成）。クリックの有無も記録する。 */
export const AUTH_LOST_SCRIPT = `
  document.querySelector('[data-bulk="true"]').addEventListener('click', () => {
    document.body.setAttribute('data-clicked', '1')
    const input = document.createElement('input')
    input.type = 'password'
    document.body.appendChild(input)
  })
`

/** クリックの少し後にパスワード入力欄を出す（観測中にセッションが失効する状況の合成）。 */
export const AUTH_LOST_DELAYED_SCRIPT = `
  document.querySelector('[data-bulk="true"]').addEventListener('click', () => {
    document.body.setAttribute('data-clicked', '1')
    setTimeout(() => {
      const input = document.createElement('input')
      input.type = 'password'
      document.body.appendChild(input)
    }, 150)
  })
`

/** 全行の更新日時が 5ms ごとに変わり続ける（自然変動の合成）。クリックの有無も記録する。 */
export const FLUCTUATING_SCRIPT = `
  let tick = 0;
  document.querySelector('[data-bulk="true"]').addEventListener('click', () => {
    document.body.setAttribute('data-clicked', '1')
  })
  setInterval(() => {
    tick += 1;
    document.querySelectorAll('td.updated-at').forEach((cell) => {
      cell.textContent = '更新日時 2026/10/01 00:00:' + String(tick % 60).padStart(2, '0')
    })
  }, 5)
`

/** 2 行目だけが 5ms ごとに変わり続ける（自然変動の合成）。 */
export const ONE_FLUCTUATING_SCRIPT = `
  let tick = 0;
  setInterval(() => {
    tick += 1;
    const cells = document.querySelectorAll('td.updated-at');
    cells[1].textContent = '更新日時 2026/10/01 00:00:' + String(tick % 60).padStart(2, '0');
  }, 5)
`
