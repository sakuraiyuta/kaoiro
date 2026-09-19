---
title: Runner artifacts
description: The release-profile install-root layout and the activation contract governing what may become `current`.
status: accepted
last_updated: 2026-09-19
related: [deployment]
---

# Runner artifacts

#### Layout

```text
<install-root>/
  releases/<revision>[-dirty]/   # tarball expansion; immutable thereafter
  current  -> releases/<revision>   # unit ExecStart goes through this
  previous -> releases/<revision>   # rollback target
```

The default `<install-root>` is Linux `${XDG_DATA_HOME:-~/.local/share}/kaoiro`
and macOS `~/Library/Application Support/kaoiro`. Override with
`KAOIRO_RUNNER_INSTALL_DIR` or each script's `--install-dir`.

**Estimate disk space.** An expanded release is **about 1 GB each** (measured
993 MB linux-x64 on 2026-09-18); the engine CLI itself is about 920 MB. The
default retention is three generations (`--keep`), using about 3 GB in
steady state.

`.lock.*` (exclusive locks) and `.staging.*` (expansion/build work areas) are
created directly under the install root. Staging from a run that missed its EXIT
trap (for example SIGKILL) is **garbage-collected immediately after the next run
acquires the lock**, so it does not accumulate.

**GC is prefix-scoped; each script targets only what it created**—install only
`.staging.install.*`, update only `.staging.build.*`. Deletion is justified only
when no other run of that script is active, within the scope guaranteed by its
lock. Install and update have separate locks, and update calls install; a glob
spanning both once let a **nested install delete an update's in-use build
directory** (`--from-repo` failed entirely; issue #219 review round 2). Lock
directories use the `.lock.*` prefix and match neither glob.

#### Activation contract (what may become `current`)

| Target | Contract |
|---|---|
| ID eligible for `current` | **Only a clean 40-digit hex**. `-dirty` / `unknown` require explicit `--allow-dirty` on a dev host |
| Reinstall a clean release | **Cannot replace** (content-addressed; reinstall is a no-op and has no override flag) |
| Reinstall dirty / unknown | Rejected by default; `--allow-dirty` permits replacement, but not while pointed to by `current` / `previous` |
| Rollback | No gate; `previous` was activated once already |

**Before a production update, confirm `git status --porcelain` is empty.** A build
from a dirty tree produces a `-dirty` ID and is rejected **before stopping the
runner** (the release-identity contract in [ADR-0018](../../adr/0018-runner-distribution.md)).
`--allow-dirty` is for development hosts; in production it makes `current` a name
whose contents are not fixed.

#### Restart policy and exit codes

- SIGTERM で runner は配下の wrapper を停止してから **exit 0** で終わる。
  systemd は `Restart=on-failure`、launchd は `KeepAlive.SuccessfulExit=false`
  なので、正常停止は再起動されない
- 起動シムは設定不備(config が無い / node が見つからない / release 検証に
  失敗)で **exit 78**(`EX_CONFIG`)を返す。検証は
  [`deploy/verify-release.mjs`](../../../runner/deploy/verify-release.mjs) が行い、**シムは
  build しない**(issue #219)。
- **どんな検証失敗も 78 へ写す**のが要点。sentinel を数個並べる方式では、
  実 dist から module を 1 つ削っただけで検査を通過し、import 時に node の
  exit 1 で落ちた — `RestartPreventExitStatus=78` が一致せず **restart loop**
  になる。78 にすることで failed のまま止まり、`systemctl --user status` に
  原因が出る。
- 検証対象は builder が生成する `MANIFEST.json`。中身は runner 自身の
  `dist/` と、runner が spawn する wrapper 2 種から **依存宣言をたどって
  到達する `@kaoiro/*` パッケージ全部**の `dist/`(`@kaoiro/wrapper-core` /
  `@kaoiro/agent-common` を含む)。dist を 3 本列挙する初版はこの推移層を
  落としており、`wrapper-core` から 1 ファイル消しても検証を通過して
  agent spawn 時に落ちた(実 tarball で実測、2026-08-16)。起動時は存在検査のみで、
  sha256 の照合は install / switch 時に行う(起動 latency を守るため)。
  **縮退の判別子は `VERSION` の有無であって、manifest が読めたかどうかでは
  ない。**`VERSION` を書くのは builder だけで、同じ実行で `MANIFEST.json` も
  書く。したがって `VERSION` があって manifest が無い木は「release が
  ファイルを失った」であり、repo-direct checkout ではない — この場合は
  exit 78 で拒否する。縮退するのは `VERSION` も無いときだけ。`ENOENT` 以外の
  read error は「不在」ではなく「読めない」として扱う。
- **install / switch は manifest を単独の証拠として扱わない。**module graph を
  独立に再導出し(各 module に書かれた import を実際に辿る)、manifest が
  取りこぼした module を拒否する。ディレクトリ列挙では削除を検出できない —
  削除されたファイルは列挙からも消えるため。`dist/cli.js` は `args.js` を
  消しても `./args.js` を import したままなので、その宙吊りの参照が検出の
  手がかりになる。
  **信頼境界: 再導出の入力は同一 tree 内の `package.json` である。**
  `MANIFEST.json` を書き換えられる主体は依存宣言も書き換えられるので、
  **これは改ざん耐性ではない。**閉じるのは builder 自身のバグと、配布後の
  部分的・素朴な破損である。その閾値を超える保証が要るなら、署名または
  tree 外の digest を別途検討すること。systemd は `RestartPreventExitStatus=78` で
  再起動せず failed のまま止まる — 原因は `systemctl --user status` に出る。
  launchd に同等の設定はないため `ThrottleInterval=30` で間隔を空けるだけで、
  原因はログファイルを見る
- サーバへ繋がらない間は runner 自身が再接続を続ける(プロセスは落ちない)ため、
  サービスマネージャ側の再起動対象はプロセス死のみ

## See Also

- [Runner update and rollback](../../operations/runner-update-and-rollback.md).
- [Multi-host deployment architecture](../../architecture/deployment.md).
