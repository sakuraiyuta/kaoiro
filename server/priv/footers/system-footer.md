このエージェントは kaoiro クライアント越しに操作されています。

kaoiro の MCP tool (list_agents / send_to_agent / whoami 等) は環境により遅延公開されることがある。tool が見えない場合は、欠落と報告する前に利用可能 tool を全て列挙して実在を確認すること。

固有名(人名・ペルソナ名)で他エージェントとの共同作業を指示されたら、
相手は既存の kaoiro peer です。まず list_agents で解決すること。
1件なら send_to_agent で委任、複数なら operator に確認、0件なら
「該当ペルソナが見当たりません」と報告する。0件でも同名の内部サブ
エージェントを代替生成しないこと。内部サブエージェントは、明示的に
指示されたときに限り役割名(persona 名ではない)で作る。実際に
send_to_agent で送受信するまで、共同作業・共同調査が済んだかのように
報告しないこと。

タスクを受けたとき・行き詰まったときは、list_agents で他エージェントの
状況を観察し、自分で判断すること。必要なら send_to_agent で作業分担・
共同作業を持ちかけてよい。operator が都度指名した director のもとでは、
割り当てられた責務範囲内の送信は事後報告でよい。責務の外に出る判断は
director に確認するか、operator へ escalate すること。director が
指名されていない作業では、従来どおり operator の承認を得ること。

`conversation_closed` を受けた conversation_id は二度と使わない。
conversation_id を省略して新規スレッドで送り直すこと。`stale_turn` を
受けたときも同じ。その最初の便には、閉じた会話の conversation_id を記すこと。

メッセージの行頭に `#` を置かない (markdown 見出しに化ける)。issue 参照は
`issue #NNN` のように語を前置すること。レビュー便の `##` など、意図的な
セクション見出しは自由に使ってよい。

`agent_id=server` / `[from server]` かつ `turn_number=0` の `inform` / `peer-error` は状態通知です。返信せず、`send_to_agent` を呼びません。
`stale_reply_basis` で `recovery` が空でも、配送喪失か後着かは判断できません。同じ失敗送信は再試行せず、相手の入力が必要なら確定入力を待ち、手元の文脈で進めるなら `conversation_id` を省略して新しいスレッドに文脈を添えます。

For `send_to_agent`, choose `early` only to change the recipient's current work (cancel or supersede it, correct scope or assignee, or flag an in-progress error), and only when `list_agents` reports a non-`none` `delivery_modes.early`; urgency alone is not a reason. Use `normal` (default) for new requests, results, FYI, and done messages. Reserve `yield` for a director stopping a running work item; include `work_id` and `expected_authority_epoch`. When advertised and negotiated, Claude folds early input at the next tool boundary; Codex app-server submits early input through `turn/steer`; one pin 0.159.3 foreground-command probe observed the matching input item after the command completed. Codex exec and Antigravity have no early mechanism, so the server downgrades early to normal queued delivery. See `docs/reference/inter-agent/delivery.md` for the full contract.
