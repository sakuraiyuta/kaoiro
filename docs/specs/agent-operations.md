---
title: エージェント運用則(multi-agent workflow)
description: 複数のエージェントが同一 work tree で並行作業するときの運用則。実装を受けた側と dispatch する側(director)の双方。engine を問わず適用する。
status: accepted
related: [protocol-inter-agent, personas]
---

# エージェント運用則(multi-agent workflow)

## Purpose

kaoiro のバックログは、複数のエージェントが同一 work tree で並行して消化
する。このファイルはそのときの運用則の**正本**で、**engine を問わず適用
する**。Claude Code 勢は [CLAUDE.md](../../CLAUDE.md) から、Codex 勢は
[AGENTS.md](../../AGENTS.md) から、それぞれここを指している。

ここに書くのは「複数のエージェントが同時に動くことに起因する」則に限る。
プロジェクトの構成・コマンド・ブランチ運用は CLAUDE.md、inter-agent
メッセージングのプロトコル仕様(envelope schema・ハード制限・turn 番号の
契約)は [protocol-inter-agent](protocol-inter-agent.md) が正本。

## 実装を受けた側

- 判断を要すると告げられた点、および実装中に見つけた「タスクの実スコープを
  変える食い違い」は独断で決めず、dispatch 元へ query を送る。往復は**実装の
  前**に行う。完了報告と同時に出すと、相手に判断の余地が残らない。
- 自分の変更が入れた不具合は in-scope。判定は「自分の diff を revert したら
  この不具合も消えるか」。消えるなら直して報告する(query は往復が増える
  だけで、director に決めることが残っていない)。消えないなら query 先行。
  ただし修正が割り当てサブディレクトリの外へ出る場合は、下記のサブ
  ディレクトリ則を優先して query する。
- 割り当てられたサブディレクトリの外は触らない。見つけた問題は報告に留める。
- 他エージェントの未 commit 変更を revert / stage しない。自分のスコープ外の
  予期しない diff は進行中の作業とみなし、存在だけを報告する。
- git: push 済み commit を amend しない。`git add -A` を使わず自分の変更
  ファイルだけを明示 add する。peer の git 操作が pending の間は同一 branch
  へ commit を差し込まない。
- peer の作業 clone / worktree は共有 work tree と同じ扱い。読み取りだけの
  git 操作(`show` / `log` / `diff` / `cat-file` / `for-each-ref`)に留め、
  `checkout` / `fetch` / `branch` / `stash` など状態を変える操作は所有者
  だけが行う。所有者の HEAD を動かすと未 merge の commit が detached HEAD
  へ取り残され、所有者は reflog を辿るまで失ったことに気づけない。未
  commit の変更の有無は所有者に確認する — `status` は index に stat 情報を
  書き戻すので、外から打つ操作ではない。
- 会話は双方が `done=true` を送って初めて終わる。相手が先に送っていても
  自分からも返す。
- flaky test は再実行の前に出力を保存する。テスト名・stack trace・seed は
  再実行が green になった瞬間に失われる(ExUnit は失敗時に
  `mix test --seed <N>` の再現行を出力する)。
- 合意した修正が「どの成果物に入ったか」を成果物ごとに確認する。1 件の合意に
  対し反映先が複数(コード / ADR / issue 本文 / 起案文面)あるとき、1 つで
  確認して残りを推定しない。

## 実装者の worktree 分離

- 実装 (ファイル編集を伴う担当) は共有 work tree 上で直接行わず、
  `<repo>/worktrees/<persona>[-<issue>]/` に作る専用 git worktree で行う。
  作成例: `git worktree add worktrees/momo-210 -b issue-210-topic develop`。
  並行案件はこの `-<issue>` 付き path で worktree を案件単位に増やし、
  閉じたら `git worktree remove` で片付ける。`/worktrees/` は
  gitignore 済み。
- repo 内に置くのは、エージェントの sandbox が session cwd 配下にしか
  書き込めないため。外部 path や別 clone は権限で詰む。
- branch は CLAUDE.md の branch strategy どおり `issue-NNN-*` を develop
  から切り、完了後に develop へ fast-forward で戻す。git は同一 branch の
  二重 checkout を拒否するので、worktree 分離は branch 分離を伴う。
- 共有 work tree (repo root) は統合・レビュー・director の読み取り面と
  し、実装の未 commit hunk を持ち込まない。
- worktree 初回作成後は各自 `pnpm install` / `mix deps.get` を実行する
  (依存はコピーされない)。不要になった worktree は
  `git worktree remove` で片付ける。
- Why: 同一ファイルに複数 writer の未 commit hunk が同居した状態での
  file 単位 stage が、他者の hunk を 2 度 commit へ巻き込んだ
  (2026-08-28、issue #232 / #203 の App.svelte)。

## dispatch する側 (director)

- peer の engine で利用できない仕組みを完了条件に課さない。Claude Code の
  custom skill と hook pipeline(`/my-code-review-cycle` 等)は
  `engine: claude-code` の peer にしか無い。代わりに具体的な検査を dispatch
  文面へ列挙する — diff の自己レビュー、該当範囲の typecheck / test、
  bugfix なら mutation または negative control による修正の実効性の証明、
  外部レビュー。
- 自セッションの rate limit 使用率は `whoami` の `rate_limits` を読む
  ([#244](https://github.com/sakuraiyuta/kaoiro/issues/244))。
  `list_agents` は呼び出し元を除外するので、自己観測はここだけである。peer の
  値を自分の代用にできるのは quota pool の共有が確認できている場合だけで、
  engine 名が同じことは共有の証拠にならない。フィールドの読み方(absent は
  unknown、snapshot は最終 turn 時点、`resets_at` 通過後は stale)は
  `list_agents` の tool description が正本で、`whoami` 側も同じ規則。
- 委任指示に自分の技術的前提を含めるときは「実測して判断し、判断と根拠を
  報告に含めること」を明示する。断定形だけで渡すと、前提が誤っていても
  そのまま実装される。
