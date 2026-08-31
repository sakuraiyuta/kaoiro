---
title: Codex internal sub-agent の runner toggle と固有名 peer-routing contract
status: accepted
date: 2026-07-15
opened: 2026-07-15
supersedes: []
superseded_by: null
related_specs: [protocol-inter-agent, plugin-model]
related_adrs: [32, 33]
---

# ADR-0038 — Codex internal sub-agent の runner toggle と固有名 peer-routing contract

## Status

Accepted (2026-07-15、マスター決裁。kaoiro peer 間 delegation でクロエへ委任、
藤がレビュー担当)。実装は
[phase-19-codex-internal-subagents-toggle](../plans/phase-19-codex-internal-subagents-toggle.md)。

## Context

固有名で共同作業を指示されたエージェント(Codex engine)が、既存の
kaoiro peer(`send_to_agent` / `list_agents` で到達する別プロセスの
エージェント)を呼ばず、Codex の `collaboration.spawn_agent` で**内部
サブエージェント**を生成し、しかもそれに peer と同じ固有名(`kuroe`)を
付ける取り違えが再発した。

根本原因は、「〜と一緒に調べて」という固有名指示が、意味論の異なる 2 つの
primitive に写像し得ることにある:

| primitive | 実体 | 到達手段 |
|---|---|---|
| 既存 peer を address する | 別プロセスの kaoiro peer(登録済み) | `list_agents` → `send_to_agent` |
| 新しい下請けを create する | engine 内部のサブエージェント(未登録) | engine 固有の spawn 機構 |

内部サブエージェントは kaoiro server に登録されないため、`list_agents` に
現れず、dashboard も偽物を直接は映せない。したがって kaoiro が唯一の
authoritative registry(`list_agents`)を持ち、固有名の解決はそこを起点に
すべき、という [protocol-inter-agent](../specs/protocol-inter-agent.md)
「宛先解決の指針」が既に MUST として存在する。再発は「prompt 規約だけでは
守られない」ことの実証である。

一方でマスターは、内部サブエージェント自体は有用であり、有効時の取り違え
リスクは許容する判断を示した。よって「既定は有効のまま維持し、operator が
runner option で明示的に無効化できる」形が求められる。無効化時のみ構造的に
止め、有効時は soft guard(prompt / provenance)で抑止する。

Codex 0.144.1 の hooks PreToolUse は tool 呼び出しを block できないため、
kaoiro 側では hard guard を実装しない(責務分担: hard guard は Codex harness
側の課題)。

## Decision

### F1 — runner config `codex.internal_subagents`(boolean、effective default true)

`runner.config.json` の `codex` ブロックに `internal_subagents`(boolean)を
追加する。未指定 / `true` = 有効(Codex 既定)、`false` = 無効。effective
default は true。厳密な boolean 検証を行い、非 boolean は loud config error に
する(`runner/src/config.ts`、`wrapper/core/src/persona.ts`)。

### F2 — effective(= configured ?? true)を常に `features.multi_agent` へ注入

runner の設定を Codex per-run config へ反映する経路:
`config.codex.internal_subagents`(file、nested)→ runner の relay
(`resolveWrapperConfig`、codex engine で `configured ?? true` を解決)→
WrapperConfig `codex_internal_subagents`(wire、flat)→
`wrapper/codex/src/host.ts` の per-run `config`。host は effective を **常に**
`features.multi_agent` へ注入する。`internal_subagents` は正の boolean で
あり、`true` は明示的な有効化(force-enable)、`false` は無効化、未指定は
effective default の `true` を明示注入する。

**precedence**: runner option を SoT とし、user-global な Codex config
(`~/.codex/config.toml` の `[features] multi_agent` 等)より **上位** とする。
effective を常に per-run config へ書き込むことで、global 設定に依らず runner
の意図が優先される。実際に内部サブエージェントを止める構造的作用は `false`
のときだけだが、`true` も precedence 確立のため明示注入する。グローバル設定を
尊重する tri-state(未指定=global に委ねる)は今回採らない(採る場合は別
key / 契約が必要)。

**live reload**: config 変更は**次回以降の spawn にのみ**反映する。稼働中の
wrapper プロセスは launch 時の値を保持し、即時変更しない
(`Supervisor.updateRuntimeConfig` は将来の spawn 用 runtime config だけを
差し替え、既存 child を kill しない)。

### F3 — 有効時の soft guard: 固有名 peer-routing contract

内部サブエージェントが有効なままでも取り違えを抑止するため、次の 3 面に
短い routing contract を同期する(soft guard):

- **common footer**(`persona_assets.ex`)— 全ペルソナ(default 含む)の
  system prompt 末尾。固有名指示は既存 peer として `list_agents` で解決
  (1件 send / 複数 operator 確認 / 0件 不在報告)、0件でも同名 internal を
  代替生成しない、internal は明示指示時に役割名で作る、実送受信前に共同
  作業済みと報告しない。
- **inter-agent tool description**(`inter_agent.ts` の `list_agents` /
  `send_to_agent`)— 同契約を model が読む description に明示。
- **spec**(`protocol-inter-agent.md`「宛先解決の指針」)— 同契約を機械的
  仕様に追補。

### F4 — hard guard(PreToolUse block)は kaoiro 側に実装しない

Codex 0.144.1 の hooks PreToolUse は tool 呼び出しを block できないため、
「spawn 前の予約名照合で hard reject」する構造 guard は kaoiro repo では
実装しない。これは Codex harness 側の課題として責務分離する(kaoiro は
authoritative registry と routing contract の供給に留まる)。

### F5 — provenance backstop は既存機構で充足、新規実装しない

「誰が・どの conversation で・実際に送受信したか」を後追いできる provenance
は、既存の `inter_agent_message` envelope が既に満たす:

- sender の `agent_id` と `persona` を envelope が stamp(`makeInterAgentMessage`)
- `conversation_id` / `turn_number` で対話を全順序リンク
- operator 限定の observation path で dashboard が送受信を両側に表示
  ([protocol-inter-agent](../specs/protocol-inter-agent.md) 観測経路)

これらは既存 test(`wrapper/agent-common/test/inter_agent.test.ts`: sender
agent_id / persona / conversation_id / turn_number の採番・単調性)で証明
済み。よって新規 provenance 機構は追加せず、本 ADR と test で「充足」を記録
するに留める。

## Consequences

### Positive

- operator が runner option 一つで Codex 内部サブエージェントを無効化でき、
  取り違えを構造的に断てる(`false` 時)。
- 既定(有効)は据え置きのため、既存挙動を退行させない。
- soft guard(footer / description / spec)が全 engine・全ペルソナに一様に
  効き、固有名指示の解決経路を明示する。
- kaoiro repo は既存の chatgpt_plan と同一経路に相乗りし、改修が config
  中継 + host + 記述層に閉じる。

### Negative

- 有効時の取り違えリスクは soft guard のみで残る(マスター許容済み)。
- common footer が全 prompt にわずかに長くなる。

### Neutral

- hard guard は Codex harness 側の責務として棚上げ(F4)。Codex hooks が
  block 可能になった時点で別途評価する。
- provenance は新規実装なし(F5)。

## Alternatives Considered

| Option | Decision |
|--------|----------|
| host は `false` のときだけ `features.multi_agent=false` を注入(true/未指定は非注入で Codex 既定に委ねる) | Reject。正の boolean `true` が no-op になり意味論が不整合。runner を global より上位にするため effective を常時注入する(藤レビュー、2026-07-15) |
| global 設定尊重の tri-state(未指定=global に委ねる / false=無効 / true=有効) | Reject。正の boolean の precedence が曖昧になる。global 尊重が要るなら別 key / 契約とする(今回不採用) |
| parse 時に default=true を materialise | Reject。parse は raw(undefined)維持、effective は relay で `?? true` 解決とする方が reload diff がきれいで chatgpt_plan と一貫 |
| kaoiro 側に PreToolUse hard guard(予約名照合で block) | Reject。Codex 0.144.1 の hooks は block 不能。Codex harness 側の責務 |
| 固有名指示を常に internal 禁止で hard block | Reject。マスターが有効時リスクを許容。既定無効化は既存挙動退行 |
| provenance を新規に stamp/表示実装 | Reject。既存 envelope + observation path で充足済み、重複実装 |

## Implementation

[phase-19-codex-internal-subagents-toggle](../plans/phase-19-codex-internal-subagents-toggle.md)。
kaoiro repo(runner config 中継 + host features + routing contract + test)と
settings repo(`dotfiles/codex` tracked source + `install.codex.sh`)を
責務分離して実装する。
