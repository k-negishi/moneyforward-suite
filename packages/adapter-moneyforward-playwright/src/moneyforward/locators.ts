import type { Locator, Page } from 'playwright'

/**
 * MoneyForward ME の画面操作に使う URL・Locator 戦略・タイムアウトの定数。
 * 出力してよいのは状態識別子と最小の進捗のみ。金額・カード番号・Cookie・セッション・
 * 更新対象年月・URL は出力しない（ADR-0011 / ADR-0016）。
 */

/** MoneyForward ME のログイン画面。 */
export const LOGIN_URL = 'https://moneyforward.com/users/sign_in'

/** ログイン状態の確認だけに使う MoneyForward ME のホーム。更新操作の導線には使わない。 */
export const ME_HOME_URL = 'https://moneyforward.com/'

/**
 * 口座一覧（家計簿）ページ。金融機関の口座行と、その行内の「更新」コントロールはこのページにある。
 * ユーザーの手動更新操作と同じ導線にするため、ホームではなくこのページを開く。
 */
export const ME_ACCOUNTS_URL = 'https://moneyforward.com/accounts'

/**
 * 行内の「更新」コントロールの表示名パターン。
 * 「編集」「削除」「更新日」等の別コントロールを拾わないよう、完全一致に近い形にする。
 * 実機では role=button の「更新」として実装されており、`<a>` / `<button>` タグではない。
 */
export const ROW_UPDATE_CONTROL_NAME_PATTERN = /^更新$/

/**
 * ページ操作のタイムアウト（ミリ秒）。
 * 呼び出し側が部分指定で上書きできるようにし、テストは実時間を待たずに短縮できる。
 */
export interface RefreshTimeouts {
  /** ページ遷移・既定のナビゲーションのタイムアウト。 */
  readonly navigationMs: number
  /**
   * 対象要素の出現待ちのタイムアウト（要素が無い場合の判定をこの時間で確定する）。
   * テストは「不在」を短時間で確定させるために短縮する。
   */
  readonly targetWaitMs: number
  /**
   * 一括更新コントロールのクリックのタイムアウト。
   * 出現待ちと作業の性質が異なるため、 targetWaitMs とは別の値にする。
   * クリックはブラウザ側で可視・安定（連続するフレームでの位置不変）・イベント受信を確認して
   * から入力イベントを送るため、要素が存在していても負荷時には複数回の往復とフレーム待ちを伴う。
   * 出現待ちの値を流用すると、テストが出現待ちを短縮した場合にクリックの予算まで過小になり、
   * 操作可能な要素でも一時障害として誤判定する（負荷時に実際に起きた）。
   */
  readonly clickMs: number
  /**
   * 一括更新のクリック後、行の変化（受付）を待つ最大時間。
   * MF は混雑時に更新を後で処理することがあり、受付の表示が遅れるため長めに取る。
   */
  readonly rowChangeMs: number
  /** 更新操作後に状態を読み直す間隔。 */
  readonly pollIntervalMs: number
  /** クリック前の比較基準を確定するための 2 回観測の間隔（自然変動する行の検出に使う）。 */
  readonly snapshotIntervalMs: number
}

/** 既定のタイムアウト。 */
export const DEFAULT_REFRESH_TIMEOUTS: RefreshTimeouts = {
  navigationMs: 30_000,
  targetWaitMs: 10_000,
  // クリックは従来 targetWaitMs（10 秒）で待っていた。既定は変えず、値を独立させる。
  clickMs: 10_000,
  rowChangeMs: 180_000,
  pollIntervalMs: 1000,
  snapshotIntervalMs: 200,
}

/** 部分指定を既定へ重ねてタイムアウトを確定する（純関数）。 */
export const resolveTimeouts = (overrides?: Partial<RefreshTimeouts>): RefreshTimeouts => ({
  ...DEFAULT_REFRESH_TIMEOUTS,
  ...overrides,
})

/** Locator の探索起点。Page 全体と、行の内側の両方で同じ探索を使う。 */
export type LocatorRoot = Pick<Page, 'getByRole' | 'getByText' | 'locator'>

/** Locator を組み立てる関数。優先順位どおりに並べて使う（ADR-0019）。 */
export type LocatorStrategy = (root: LocatorRoot) => Locator

/**
 * 更新対象の口座行（「更新」コントロールを含む行）を探す優先順位。
 * role → CSS の順（ADR-0019）。実機では口座一覧は tr（role=row）で、「更新」は role=button。
 * 行の特定は誤クリックに直結しない（クリックは行ではなく一括更新コントロールに対して行う）ため、
 * role で見つからない場合に備えて CSS のフォールバックも置く。見つからない場合は停止する（fail closed）。
 */
export const ACCOUNT_ROW_STRATEGIES: readonly LocatorStrategy[] = [
  (root) =>
    root
      .getByRole('row')
      .filter({ has: root.getByRole('button', { name: ROW_UPDATE_CONTROL_NAME_PATTERN }) }),
  (root) =>
    root
      .locator('tr')
      .filter({ has: root.getByRole('button', { name: ROW_UPDATE_CONTROL_NAME_PATTERN }) }),
  (root) =>
    root
      .locator('tr')
      .filter({ has: root.getByRole('link', { name: ROW_UPDATE_CONTROL_NAME_PATTERN }) }),
  (root) =>
    root
      .getByRole('listitem')
      .filter({ has: root.getByRole('button', { name: ROW_UPDATE_CONTROL_NAME_PATTERN }) }),
]

/**
 * 一括更新コントロールの表示名の候補（具体的な順）。実機では「金融機関からのデータ一括更新」で一致する。
 * 部分一致で評価されるため、広い「一括更新」を先にすると別要素（説明文等）を
 * 拾い得る。具体的な候補から順に試す。
 */
export const BULK_UPDATE_CONTROL_NAME_CANDIDATES: readonly RegExp[] = [
  /金融機関からのデータ一括更新/,
  /データ一括更新/,
  /一括更新/,
]

/**
 * ページ全体から一括更新コントロールを探す優先順位。
 * role + accessible name の一致のみを使う。テキスト一致や属性による広いフォールバックは、
 * 説明文等の別要素を拾って誤操作につながるため持たない。見つからない場合は停止する（fail closed）。
 * 実機では「金融機関からのデータ一括更新」が role=button として一致している。
 */
export const BULK_UPDATE_CONTROL_STRATEGIES: readonly LocatorStrategy[] = [
  ...BULK_UPDATE_CONTROL_NAME_CANDIDATES.map(
    (name) => (root: LocatorRoot) => root.getByRole('button', { name }),
  ),
  ...BULK_UPDATE_CONTROL_NAME_CANDIDATES.map(
    (name) => (root: LocatorRoot) => root.getByRole('link', { name }),
  ),
]

/**
 * 認証チャレンジ（追加の本人確認）の「入力要求」を示す具体的な文言のみを登録する。
 * 「ワンタイムパスワード」「確認コード」「新端末」のような一般語は、ログイン後の通常ページの
 * 案内文にも現れて誤検知するため登録しない（誤検知は AUTH_REQUIRED の誤停止につながる）。
 * 実機の文言を確認して差し替える。検知したら自動回避せず停止する（ADR-0015）。
 * 制限: CAPTCHA（「私はロボットではありません」）は cross-origin iframe 内に描画される場合があり、
 * 本文の innerText では検知できない可能性がある（その場合、文言ベースの検知は効かない）。
 */
export const AUTH_CHALLENGE_TEXT_MARKERS: readonly string[] = [
  'ワンタイムパスワードを入力',
  '確認コードを入力',
  '認証コードを入力',
  '私はロボットではありません',
]

/**
 * 認証チャレンジの入力欄を検知する CSS セレクタ。
 * ログイン済みの通常ページには現れない入力欄（パスワード・ワンタイムコード）だけを対象にする。
 */
export const AUTH_CHALLENGE_INPUT_SELECTOR = [
  'input[type="password"]',
  'input[autocomplete="one-time-code"]',
].join(', ')

/**
 * ログイン画面の URL かどうか（セッション失効によるリダイレクトの検知に使う）。
 * 別ドメインのログイン基盤（id ドメイン）や、パスにサインイン系の語を含む URL も
 * サインイン導線として扱う（見逃すと未認証のまま操作を続けるため、誤検知側へ倒す = fail closed）。
 * 実機で実際のリダイレクト先を確認して調整する。
 */
export const isSignInUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.toLowerCase()
    const pathname = parsed.pathname.toLowerCase()
    // id ドメイン（id.moneyforward.com 等）はログイン基盤そのもののため、パスによらずサインイン扱いにする。
    if (hostname.startsWith('id.')) {
      return true
    }
    return (
      pathname.startsWith('/users/sign_in') ||
      pathname.includes('sign_in') ||
      pathname.includes('signin') ||
      pathname.includes('login')
    )
  } catch {
    return false
  }
}

/**
 * 可視テキストに入力要求の文言が含まれるか。
 * 文言が画面幅で折り返され、間に空白・改行が入っても検知できるよう、正規化に加えて空白を除去する。
 */
export const containsAuthChallenge = (text: string): boolean => {
  const normalized = text.normalize('NFKC').replace(/\s+/gu, '').toLowerCase()
  return AUTH_CHALLENGE_TEXT_MARKERS.some((marker) => normalized.includes(marker.toLowerCase()))
}

/** 認証チャレンジ検知に使う観測値（Page からの取得は呼び出し側で行う）。 */
export interface AuthChallengeSignals {
  readonly visibleText: string
  readonly visibleChallengeInputCount: number
}

/**
 * 認証チャレンジを検知する。
 * 可視の入力欄を主シグナル、入力要求の文言を補助シグナルとして使う。
 * どちらも無ければチャレンジではないと判定する。
 */
export const isAuthChallengeDetected = (signals: AuthChallengeSignals): boolean =>
  signals.visibleChallengeInputCount > 0 || containsAuthChallenge(signals.visibleText)
