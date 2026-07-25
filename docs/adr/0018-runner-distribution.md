---
title: wrapper/runner の配布(OS 別単一バイナリ・CLI のみ・Gitea release)
status: accepted
date: 2026-06-16
opened: 2026-06-16
supersedes: []
superseded_by: null
related_specs: [setup-wizards]
related_adrs: [17, 23, 24]
---

# ADR-0018 — wrapper/runner の配布

## Status

Accepted(着手は主要機能が出揃ってから — 延期)

## Context

wrapper/runner を各ホスト(Linux/macOS/Windows、ヘッドレス含む)へ配布・
インストールする方式が未定。設定生成は [setup-wizards](../specs/setup-wizards.md)
(provisional)に既にあるが、配布(パッケージング)は未仕様。最終目標の
「リソース管理トータルソリューション」では CUI のみのホストでも動かす必要がある。

## Decision

- 配布形態は **OS 別の単一実行バイナリ**(ランタイム同梱でコンパイル、Node 前提を
  排除)。
- **CLI のみ(GUI 不採用)**。CUI のみ・ヘッドレスなホストでも動かせること。
- 設定生成は setup-wizards の拡張: (i) 設定が無ければ**初回起動でウィザードを
  自動起動**、(ii) 設定を **OS 別ユーザ設定ディレクトリ**(Linux `~/.config`、
  macOS `~/Library/Application Support`、Windows `%APPDATA%`)に置く。
- 配布チャネルは **当面 Gitea の release(バイナリ資産)**、将来 GitHub 公開時に
  GitHub releases。

**着手タイミングは主要機能が出揃ってから**(低優先・延期)。

### 改訂(2026-07-25)— 単一バイナリを延期し Node 前提 tarball を先行

マスター判断により **単一バイナリ化(bun compile)は撤回・延期**し、当面は
**Node ランタイムのみを前提とする自己完結 tarball** で配布する(issue #70)。

撤回の根拠:

- bun が Zig → Rust の全面書き換え直後(2026-05 マージ / 07 公表)で不安定期
- `sharp` のネイティブ `.node` が `bun build --compile` に埋め込めない既知の
  未解決問題(sharp#4283 / bun#15374)
- wrapper は Agent SDK 経由でエンジン CLI を子プロセス起動するため、単一
  バイナリでも配布先のランタイム前提は消えない — **ただし下記の実測で訂正**

**実測による訂正**: エンジン CLI の実体は SDK が platform 別 npm パッケージと
して同梱している(`@anthropic-ai/claude-agent-sdk-<os>-<arch>` 245 MB /
`@openai/codex-<os>-<arch>` 297 MB)。そのため tarball 配布では **配布先ホスト
に Claude Code / codex CLI を別途用意する必要がない**。裏返しとして sharp・
canvas・両 CLI がすべて platform 別 optional dependency であるため、**OS/arch
別アーカイブが必須**になる。

改訂後の決定:

- 生成は [`scripts/build-runner-tarball.sh`](../../scripts/build-runner-tarball.sh)
  (`pnpm deploy --legacy` の成果物をそのまま tar.gz 化)
- 生成対象は実需要の **2 arch(`darwin-arm64` / `linux-x64`)**。4 arch を
  一律には作らない
- クロスビルドは pnpm の `supportedArchitectures` をビルド中だけ注入して行う
  (darwin ホスト 1 台から両方生成できることを実測で確認)
- 設置は「解凍 → 設定ファイル編集 → ワンコマンド実行」以内。配布先で
  `pnpm install` / build / workspace 解決を要求しない
- 常駐化(#141)の起動シム・unit・plist は **無改造で配布物に載る**(シムは
  自分の位置から `../dist/cli.js` を解決し、`deploy/` と `dist/` が成果物直下で
  兄弟になる)
- Gitea release への資産アップロード自動化は範囲外(#145)
- **`bun compile` は Rust 版の安定後(目安 2027-01)に再評価**する。SDK 側に
  Bun single-file executable 向けの `extractFromBunfs` ヘルパが用意されている
  ため、sharp 側の解決が前提条件

アーカイブサイズ(実測、tar.gz): **darwin-arm64 256 MB / linux-x64 368 MB**。
linux 版は musl 変種も同梱されるため大きい代わりに glibc / musl 両対応になる
(`supportedArchitectures.libc` では musl 変種を除外できなかった)。

## Consequences

### Positive

- Node 無しでクロス OS 導入が滑らか。ヘッドレス運用に適合。
- 自己ホスト(Gitea)で配布が完結する。

### Negative

- OS 別クロスビルドの CI と単一バイナリ化ツールの選定が要る。
- tarball(2026-07-25 改訂)はエンジン CLI 実体を含むため 1 arch あたり
  256〜368 MB(tar.gz)。自己ホスト Gitea の release 資産としては許容と判断。
- 配布先に Node(>= 22)が必要。単一バイナリ化までこの前提は残る。

### Neutral

- 配布単位は [ADR-0017](0017-wrapper-multientity-packages.md) のパッケージ分割に
  依存。runner の常駐デーモン仕様は
  [ADR-0023](0023-host-runner-architecture.md)(supervisor 専任・TS/Node・
  `kaoiro-runner`)で確定し、[ADR-0014](0014-session-resume-and-restore.md) の
  resume と直結。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| npm/pnpm パッケージ(`npm i -g`) | 各ホストに Node 前提。ヘッドレス最小構成に不利 |
| コンテナ配布 | runner はホストの `~/.claude`・ローカルプロセス・cwd へアクセスするため不向き |
| GUI インストーラ / GUI 設定 | CUI のみホストで動かせない |
| 公開 npm へ publish | GitHub 公開までは Gitea release で足りる |

## Related

- spec: [setup-wizards](../specs/setup-wizards.md)。
- 関連 ADR: [0017](0017-wrapper-multientity-packages.md)、
  [0014](0014-session-resume-and-restore.md)。
- 未解決(2026-07-25 時点): 単一バイナリ化ツールの選定は `bun compile` の再評価
  待ち(Rust 版安定後、目安 2027-01)。runner/wrapper を 1 バイナリにするかは
  単一バイナリ前提の論点なので同じく保留 — tarball では 1 アーカイブに両方が
  入るため実務上は解決している。クロスビルドは pnpm の `supportedArchitectures`
  で解決済み(darwin ホストから linux-x64 を生成できることを実測)。
- 由来: my-idea-brief(走り書き「wrapper/runner の配布」)。
