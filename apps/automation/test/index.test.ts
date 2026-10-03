// package 名で import する。Vitest の alias が @mf-suite/core を
// packages/core/src/index.ts へ解決できること（テストがビルド不要で動くこと）を検証する。
// 注意: alias は package 名を直接 src へ解決するため、「workspace 依存の宣言」そのものは
// このテストでは検証できない（依存を削除してもテストは緑のまま。検出は `pnpm typecheck` の
// `tsc -b` / `pnpm build` が担う）。実 export が入れば assert も意味を持ち始める。
import * as core from '@mf-suite/core'
import { describe, expect, it } from 'vitest'

describe('workspace 配線の smoke test', () => {
  it('@mf-suite/core を package 名で解決できる', () => {
    expect(core).toBeTypeOf('object')
  })
})
