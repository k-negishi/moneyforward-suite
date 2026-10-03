import { describe, expect, it } from 'vitest'
import type { LocatorRoot } from '../src/moneyforward/locators.js'
import {
  AUTH_CHALLENGE_INPUT_SELECTOR,
  BULK_UPDATE_CONTROL_NAME_CANDIDATES,
  BULK_UPDATE_CONTROL_STRATEGIES,
  containsAuthChallenge,
  isAuthChallengeDetected,
  isSignInUrl,
  ROW_UPDATE_CONTROL_NAME_PATTERN,
} from '../src/moneyforward/locators.js'

/** 一括更新コントロールの探索が呼ぶ role 指定（テキスト・属性のフォールバックを禁じる）。 */
const BULK_UPDATE_ROLE_CALL_PATTERN = /^getByRole:(button|link)$/

// 合成した文言のみを使う（本番の DOM / HTML は使わない）。
describe('containsAuthChallenge', () => {
  const cases: [string, boolean][] = [
    // 入力要求の具体的な文言（検知する）
    ['ワンタイムパスワードを入力してください', true],
    ['確認コードを入力', true],
    ['認証コードを入力して本人確認を行います', true],
    ['私はロボットではありません', true],
    // 一般語・通常の案内文（検知しない）
    ['ワンタイムパスワードの設定は設定画面から行えます', false],
    ['ワンタイムパスワードをご利用の方はこちら', false],
    ['確認コードの有効期限は 10 分です', false],
    ['新しい端末からログインした場合は本人確認が必要です', false],
    ['キャプチャ画像を登録する', false],
    ['ようこそ MoneyForward ME へ', false],
    ['', false],
  ]

  it.each(cases)('%s → %s', (text, expected) => {
    expect(containsAuthChallenge(text)).toBe(expected)
  })

  it('一般語を含むだけの長い案内文では検知しない', () => {
    const text = [
      'ログイン時の確認について',
      'ワンタイムパスワードや確認コードは、設定画面から変更できます。',
      '新しい端末を登録した場合は、ご登録のメールアドレスへお知らせします。',
    ].join('\n')

    expect(containsAuthChallenge(text)).toBe(false)
  })

  it('画面幅で折り返され空白・改行が入った文言も検知する', () => {
    expect(containsAuthChallenge('ワンタイムパスワードを\n入力してください')).toBe(true)
    expect(containsAuthChallenge('確認コードを　入力')).toBe(true)
  })

  it('全角の一般語だけでは検知しない', () => {
    expect(containsAuthChallenge('ワンタイムパスワードの設定')).toBe(false)
  })
})

describe('ROW_UPDATE_CONTROL_NAME_PATTERN', () => {
  it('「更新」に完全一致する', () => {
    expect(ROW_UPDATE_CONTROL_NAME_PATTERN.test('更新')).toBe(true)
  })

  it('「編集」「削除」「更新日」等の別コントロールを拾わない', () => {
    expect(ROW_UPDATE_CONTROL_NAME_PATTERN.test('編集')).toBe(false)
    expect(ROW_UPDATE_CONTROL_NAME_PATTERN.test('削除')).toBe(false)
    expect(ROW_UPDATE_CONTROL_NAME_PATTERN.test('更新日')).toBe(false)
    expect(ROW_UPDATE_CONTROL_NAME_PATTERN.test('更新する')).toBe(false)
    expect(ROW_UPDATE_CONTROL_NAME_PATTERN.test('再取得')).toBe(false)
  })
})

describe('BULK_UPDATE_CONTROL_STRATEGIES', () => {
  /** 呼び出しを記録する LocatorRoot のスパイ。 */
  const createRootSpy = (): { root: LocatorRoot; calls: string[] } => {
    const calls: string[] = []
    const root = {
      getByRole: (role: string) => {
        calls.push(`getByRole:${role}`)
        return {}
      },
      getByText: () => {
        calls.push('getByText')
        return {}
      },
      locator: (selector: string) => {
        calls.push(`locator:${selector}`)
        return {}
      },
    } as unknown as LocatorRoot
    return { root, calls }
  }

  it('role + accessible name の一致のみで探す（テキスト一致・属性のフォールバックを持たない）', () => {
    for (const strategy of BULK_UPDATE_CONTROL_STRATEGIES) {
      const { root, calls } = createRootSpy()

      strategy(root)

      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatch(BULK_UPDATE_ROLE_CALL_PATTERN)
    }
  })

  it('表示名の候補 × role（button / link）の分だけ持つ', () => {
    expect(BULK_UPDATE_CONTROL_STRATEGIES).toHaveLength(
      BULK_UPDATE_CONTROL_NAME_CANDIDATES.length * 2,
    )
  })
})

describe('isAuthChallengeDetected', () => {
  it('可視の入力欄があれば検知する', () => {
    expect(
      isAuthChallengeDetected({ visibleText: 'ようこそ', visibleChallengeInputCount: 1 }),
    ).toBe(true)
  })

  it('入力欄がなく、入力要求の文言もなければ検知しない', () => {
    expect(
      isAuthChallengeDetected({
        visibleText: 'ワンタイムパスワードの設定は設定画面から行えます',
        visibleChallengeInputCount: 0,
      }),
    ).toBe(false)
  })

  it('入力欄がなくても、入力要求の文言があれば検知する', () => {
    expect(
      isAuthChallengeDetected({
        visibleText: 'ワンタイムパスワードを入力してください',
        visibleChallengeInputCount: 0,
      }),
    ).toBe(true)
  })
})

describe('AUTH_CHALLENGE_INPUT_SELECTOR', () => {
  it('パスワード入力欄とワンタイムコード入力欄を対象にする', () => {
    expect(AUTH_CHALLENGE_INPUT_SELECTOR).toContain('input[type="password"]')
    expect(AUTH_CHALLENGE_INPUT_SELECTOR).toContain('input[autocomplete="one-time-code"]')
  })
})

describe('isSignInUrl', () => {
  it('sign_in のパスは true', () => {
    expect(isSignInUrl('https://moneyforward.com/users/sign_in')).toBe(true)
    expect(isSignInUrl('https://moneyforward.com/sign_in')).toBe(true)
  })

  it('pathname に signin / login を含む URL も true（fail closed）', () => {
    expect(isSignInUrl('https://example.invalid/signin')).toBe(true)
    expect(isSignInUrl('https://example.invalid/login')).toBe(true)
  })

  it('id ドメイン（ログイン基盤）はパスによらず true', () => {
    expect(isSignInUrl('https://id.moneyforward.com/')).toBe(true)
    expect(isSignInUrl('https://id.moneyforward.com/oauth/authorize')).toBe(true)
  })

  it('通常のパスは false', () => {
    expect(isSignInUrl('https://moneyforward.com/')).toBe(false)
    expect(isSignInUrl('https://moneyforward.com/accounts')).toBe(false)
  })

  it('URL として解釈できない場合は false', () => {
    expect(isSignInUrl('not-a-url')).toBe(false)
  })
})
