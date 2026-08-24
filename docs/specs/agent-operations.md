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
- 委任は deliverable を**成果の単位**(「N 件 merge され checker green」)で
  名指し、review round 予算を明記する。予算超過が生むのは追加 round では
  なく報告義務である。
- director は活動量でなく deliverable の前進を観測する。メッセージ数が
  増えながら成果の単位が進まないことが、レビュー泥沼の最良の検知信号で
  ある。

## レビュー往復の統治(round budget)

reviewer と implementer が peer 同士で回すレビューに適用する。深さ自体は
正しい場面では価値がある — ここで縛るのは深さの配分と往復の上限で、
判定は**数えるだけでできるもの**に限る。

| トリガ | 閾値 | 発火時の義務 |
|---|---|---|
| 同一 deliverable への must-fix round 通算 | 3 round 超 | reviewer / implementer 双方が director へ報告して停止 |
| 指摘が「タスク中に作った道具の障害モード」のみ | 2 round 連続 | 停止し、道具の存否を director が裁定 |
| review round 中の対象 / verifier の変更 | 0(freeze) | 変更は round 境界でのみ。破った round の evidence は無効 |
| 同一 deliverable に関する会話のラリー通算 | 20 往復 | 会話を閉じ、要約を添えて director へ判断を上げる |

- カウンタの母集団は deliverable であり、**当事者が再設定できない**。
  artifact の差し替え・verifier の移動・conversation の張り直しでは 0 に
  戻らない(round 境界での差し替えは正当な変更だが、カウントは引き継ぐ)。
  通算は director が保持し、dispatch と round 開始時に現在値を明示する。
  artifact 単位で数えると、verifier が 3 回移動した M18 の泥沼でも通算は
  1 のままだった — 母集団が動くカウンタは弁にならない。
- 閾値到達は設計上の弁であって、誰の失点でもない。escalation は敗北では
  なく義務である。permit・hash 束縛のような round 内の精緻な手続きが
  整っていても、報告義務の代わりにならない — 手続きが整うほど、ループの
  中に留まることが正当に見えるからだ。
- 検証深度の配分(使い捨て道具を adversarial review の対象にしない)は
  各エージェントのグローバル規則が正本(Claude: rules/verification.md
  「Depth is set by blast radius」、Codex: AGENTS.md 検証節)。ここでは
  重複させない。

Why: 2026-08-24、issue #91 の翻訳 wave で、使い捨て merge script への
must-fix が M18 まで達した(数十往復・deliverable 前進ゼロ・escalation
なし)。各 round は局所的には規律に忠実で、外から観測できた異常は round
数と成果の停滞だけだった。
