import { describe, expect, it } from 'vitest'

// package 名で import する。この 1 本で「workspace 依存の宣言」「package 名の解決」
// 「Vitest alias（packages/core/src/index.ts への解決）」という壊れやすい配線を検証する。
import * as core from '@mf-automation/core'

describe('workspace 配線の smoke test', () => {
  it('@mf-automation/core を package 名で解決できる', () => {
    expect(core).toBeTypeOf('object')
  })
})
