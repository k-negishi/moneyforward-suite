#!/bin/sh
# セッション開始時に、いま master にいて追跡ファイルに差分がないときだけ origin/master へ
# fast-forward する。古い master からブランチを切ってしまう事故を防ぐためのもの。
#
# 次の場合は何もしない:
#   - master 以外のブランチ、または detached HEAD
#   - 追跡ファイルに未コミットの変更（staged / unstaged）がある
#   - ローカルの master が origin/master から分岐している（未 push のコミットがある）
#   - origin へ到達できない、または認証を求められる
#
# 更新は --ff-only に限定するため、コミットが失われる経路はない。作業ツリー上の
# 追跡外ファイルの保護は 2 段階になる。未追跡（ignore されていない）ファイルの上書きは
# git merge が既定で拒否する。ignored ファイルは既定では黙って上書きされるため、
# --no-overwrite-ignore で拒否させる。どちらの場合も merge が中止され、このスクリプトは
# 何もしない。
# 失敗はすべて exit 0 で握りつぶし、セッション開始を妨げない。

git rev-parse --git-dir >/dev/null 2>&1 || exit 0

# master にいて追跡ファイルが clean かどうかだけを見る。ネットワークも remote-tracking
# ref も使わないため、fetch の前後どちらで評価しても結論が変わらない。
on_master_and_clean() {
  [ "$(git symbolic-ref --quiet --short HEAD 2>/dev/null)" = "master" ] || return 1
  git diff --quiet 2>/dev/null || return 1
  git diff --cached --quiet 2>/dev/null || return 1
  return 0
}

# 事前判定。master 以外や差分ありのときに fetch を省く。
on_master_and_clean || exit 0

# 認証を求められたら待たずに失敗させる。ハングして timeout で kill されると、
# 下の || exit 0 が働かないままセッション開始が遅れる。
GIT_TERMINAL_PROMPT=0 git fetch --quiet origin master 2>/dev/null || exit 0

# ここから下は fetch の後に判定する。fetch は秒単位かかり得るので、その間に他セッションが
# ブランチを切り替えたり編集を始めていないかを再確認してから merge する。事前判定の結果を
# 使い回すと、判定時点と merge 時点の HEAD が食い違い、意図しないブランチを進め得る。
# origin/master を見る判定を fetch より前に置かないこと（ref が古いままで誤判定する）。
on_master_and_clean || exit 0
git merge-base --is-ancestor HEAD origin/master 2>/dev/null || exit 0
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/master)" ] && exit 0

before=$(git rev-parse --short HEAD)
git merge --ff-only --no-overwrite-ignore --quiet origin/master 2>/dev/null || exit 0
after=$(git rev-parse --short HEAD)

printf 'master を origin/master に fast-forward 更新しました: %s -> %s\n' "$before" "$after"
