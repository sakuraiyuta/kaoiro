# @kaoiro/wrapper

kaoiro のラッパー層(TypeScript)。Claude Agent SDK をホストし、SDK メッセージ
列から kaoiro の状態を導出して共通エンベロープへ翻訳する。

仕様: [docs/specs/protocol.md](../docs/specs/protocol.md),
[docs/specs/agent-sdk-events.md](../docs/specs/agent-sdk-events.md)。
計画: [docs/plans/phase-1-wrapper-state-machine.md](../docs/plans/phase-1-wrapper-state-machine.md)。

## 現状(Phase 1)

状態導出ロジックを SDK 依存から切り離した純粋関数として実装し、モックの
アダプタイベント列でユニット検証している。実 SDK ホスト(`query()` /
`canUseTool` / ストリーミング入力)の配線は次フェーズ。

| モジュール | 役割 |
|---|---|
| `src/types.ts` | 状態セット・共通エンベロープ v0・アダプタ入力イベントの型 |
| `src/state.ts` | 状態導出(`deriveStates` / `reduceStates`)とエンベロープ生成 |
| `src/persona.ts` | ペルソナ・安定 ID 設定の読み込みと検証 |

`AdapterEvent` は SDK メッセージ列 + `canUseTool` を正規化した状態機械の入力。
実 SDK 型からこの形への橋渡しを次フェーズのアダプタで行う。

## 開発

```sh
pnpm install
pnpm test       # vitest
pnpm typecheck  # tsc --noEmit
```

設定ファイルの例は [kaoiro.config.example.json](kaoiro.config.example.json)。
