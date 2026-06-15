---
title: wrapper/runner の配布(OS 別単一バイナリ・CLI のみ・Gitea release)
status: accepted
date: 2026-06-16
opened: 2026-06-16
supersedes: []
superseded_by: null
related_specs: [setup-wizards]
related_adrs: [17]
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

## Consequences

### Positive

- Node 無しでクロス OS 導入が滑らか。ヘッドレス運用に適合。
- 自己ホスト(Gitea)で配布が完結する。

### Negative

- OS 別クロスビルドの CI と単一バイナリ化ツールの選定が要る。

### Neutral

- 配布単位は [ADR-0017](0017-wrapper-multientity-packages.md) のパッケージ分割に
  依存。runner の常駐デーモン仕様は [ADR-0014](0014-session-resume-and-restore.md)
  / issue #23 と直結。

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
- 未解決: 単一バイナリ化ツール選定・クロスビルド CI・runner/wrapper を1バイナリに
  するか分けるか(実装時)。
- 由来: my-idea-brief(走り書き「wrapper/runner の配布」)。
