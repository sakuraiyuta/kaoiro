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
  **(i) は撤回済み** — [setup-wizards](../specs/setup-wizards.md)(2026-07-25
  accepted、issue #144)で「自動起動はせず、起動シムは exit 78 で止まって
  ウィザードのコマンドを案内する」に上書きした。systemd / launchd から起動
  された非対話セッションで対話プロンプトが立ち上がると、TTY が無いまま無応答
  で止まるため。(ii) はそのまま有効。
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

### 改訂(2026-08-16)— 設置形態を immutable release + atomic switch に統一する

[issue #229](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/229)。
本 ADR はここまで tarball の**生成**だけを決めており、**設置後の形**を
決めていなかった。その空白に、文書上どこにも書かれていない運用形態が
入り込んでいた — **リポジトリの checkout を live path にしたまま常駐させ、
更新のたびに稼働中の `dist` を上書きする**形態である(本番ホストが実際に
この形で動いていた)。

これが危険なのは、**runner が wrapper を spawn するたびに on-disk の
artifact を解決する**ため。`runner/src/spawn.ts` の
`resolveWrapperLaunch()` は `require.resolve()` でパスを引き、しかも
engine ごとに lazy である(codex は初回 codex spawn まで解決しない)。
稼働中の checkout を build し直すと、旧 runner が新 wrapper を掴む、
あるいはパッケージ間で新旧の混ざった module graph を掴む。
[issue #219](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/219)
で観測された `ConfigError` はその一例にすぎず、**version check を足しても
partial module graph は救えない**。「停止 → build → 起動」の順序を人間が
守ることで回避していたが、順序を一度誤れば再発する。

#### 決定

**設置先は immutable な release ディレクトリとし、live path は symlink
1 本(`current`)だけにする。**

```text
<install-root>/
  releases/<revision>[-dirty]/   # tarball を展開したもの。以後不変
  current  -> releases/<revision>
  previous -> releases/<revision>
```

`<install-root>` は Linux `${XDG_DATA_HOME:-~/.local/share}/kaoiro`、
macOS `~/Library/Application Support/kaoiro`(`KAOIRO_RUNNER_INSTALL_DIR`
で上書き可)。macOS では config dir と同一ディレクトリになる — Apple は
data / config を分けないため。entry 名は衝突しない。

**source origin と activation layout は別軸である**。混同すると
「repo で動かす形態」という、もう存在しない選択肢を文書が生かし続けることに
なる。

| 軸 | 取りうる値 |
|---|---|
| **source origin** | Gitea release の tarball / ローカル repo の build |
| **activation layout** | **どちらも** `releases/<id>/` + `current` の 1 通りのみ |

- したがって従来「repo-direct」と呼んでいた形態は
  **local-build release profile** と呼ぶ。repo は **build 元**であって
  live path ではない。tarball 配布ホストと**同一の設置形態・同一の
  スクリプト**に収束するため、実行経路は 1 本しかない
- **repo checkout を `ExecStart` に直接指す形態は、profile として認めない**
  (開発時に手で起動する分には従来どおり使える)
- **切替は停止後に、一時 symlink + `rename(2)` で atomic に行う**。`mv` は
  使えない — 宛先が directory への symlink のとき `mv` はそれを**追従して
  中へ**移動する(GNU coreutils 9.4 で実測: `current` は旧 release を指した
  まま、旧 release の中に一時 symlink が残った)。GNU の `mv -T` は正しいが
  BSD / macOS に無いため、`rename(2)` を node 経由で呼ぶ
- **直前の release を `previous` として保持する**。保持世代数の既定は 3
  (`--keep`)。ただし `current` / `previous` が指す release は世代数に
  関わらず削除しない — 上記の lazy な wrapper 解決のため、稼働中 release は
  起動後ずっと読まれ続ける
- **起動シムは build せず verify のみ行う**。`dist/cli.js` /
  `dist/build-info.json` / wrapper 2 種の `dist/cli.js` の存在を検査する
- **更新は `systemd-run --user --no-block` の transient *service* unit で
  実行する**。runner 配下のエージェントが更新スクリプトを直接叩くと、runner
  を停止した瞬間に自分が消えて後続が走らない

#### 効いているのは cgroup であって process group ではない

`systemd.kill(5)` の既定は `KillMode=control-group` — 「all remaining
processes in the control group of this unit will be killed on unit stop」。
**呼び出し元の process group から抜けても、runner service の cgroup に残って
いれば道連れで死ぬ**。逃れられるのは transient *service* unit になることで、
`systemd-run(1)` は「will run in a clean and detached execution environment,
with the service manager as its parent process」と述べている。

したがって起動引数には次の 3 つが必須で、いずれも欠落は致命的:

- **`--scope` を使わない。** transient scope は systemd-run 自身が実行し
  「will thus inherit the execution environment of the caller」、しかも
  同期実行になる。停止対象の unit の中へ更新を戻すことになり、`--no-block`
  とも併用できない
- **`PartOf` / `BindsTo` を付けない。** runner の停止が別経路で伝播する
- **`--no-block` を付ける。** 最初の仕事が呼び出し元の停止である unit の
  起動完了を待たせない

排他 lock を併用する。

#### `--detach` は成功を報告しない

`--no-block` は start request が「only verified and enqueued」された時点で
返る (`systemd-run(1)`)。**更新は開始すらしていない**ので、`--detach` の
終了ステータスは結果について何も語らない。出力は「enqueue した」ことと
unit 名、および journal / status の確認コマンドに限る。最終確認はオペレータ
が行う。

#### 中断した staging の GC

install / build の staging ディレクトリは 1 本あたり 1 GB を超える。EXIT
trap に到達せず死んだ run (SIGKILL、電源断) の残骸は、死んだ pid を名前に
持つだけで誰も再訪しない。**排他 lock を取得した直後、自分の staging を作る
前に GC する** — lock が「まだ在るものは放棄されたもの」を真にする。lock
ディレクトリ (`.lock.*`) と staging (`.staging.*`) は接頭辞を分け、GC の
glob が自分の lock を巻き込まないようにする

**`ExecStartPre=pnpm build` は採用しない。** crash restart や OS 起動を
コンパイラ / node_modules / pnpm の成否に結びつけ、build 中ずっと停止し、
失敗時に中途半端な `dist` を残しうる。「`dist` が HEAD より古い」判定も
lockfile / tsconfig / dependency / 削除済みファイル / dirty tree を
表現できない。

#### release identity の契約

[ADR-0053](0053-build-identity.md) の identity は `revision` + `dirty` で
あり、**`dirty` は「この SHA では中身が決まらない」と言っている**。つまり
同一 commit の別 dirty build は **id が衝突しながら内容が異なる**。
`current` はホストが何を動かしているかを決める名前なので、これを許すと
「実際は何が動いているのか」という問いが一段上に戻ってくるだけである。

| 対象 | 契約 |
|---|---|
| **activation** (`current` になれる id) | **clean な 40 桁 hex のみ**。`-dirty` / `unknown` は `--allow-dirty` を明示した dev ホストに限る |
| **clean release の再 install** | **置き換え不可**。content-addressed なので再 install は no-op。置き換えるフラグは用意しない |
| **dirty / unknown release の再 install** | 既定で拒否。`--allow-dirty` で置換可。ただし `current` / `previous` が指す間は不可 |
| **rollback** | gate をかけない。`previous` は一度 activate 済みであり、拒否は壊れた release にホストを縛りつけるだけ |

clean release を置き換える手段を用意しないことが、`releases/<clean-id>/` を
「慣習として不変」でなく**実際に不変**にしている。破損を疑うなら手で消す —
痕跡が残る。黙って上書きする経路は残さない。

**id は path component になるため、値域検証は security boundary である。**
`grep -q '^…$'` は行単位に錨を打ち、どれか 1 行が一致すれば成功するため、
**複数行の値を検証できない**。実測 (2026-08-16): VERSION が
`../../pwned-marker\n<40 hex>` の tarball は検証を通り、install root の
2 階層上に release tree を書いて exit 0 で終わった。`$(cat FILE)` は末尾の
改行しか落とさず、改行は path separator でもないため traversal を妨げない。
検証は shell の `case` glob で id の文字集合外 (改行・`/`・`.` を含む) を
落としてから行う。

#### 前提の実測(2026-08-16)

この設計は「稼働中 runner は `current` の切替に影響されない」ことに依存する。
Node は既定で module path を realpath 化するため成立するが、断定せず実測した:
`current/deploy/` 経由で起動したプロセスの `import.meta.url` は
`releases/<id>/dist/cli.js` に解決され、**`current` を別 release へ切り替えた
後の lazy な `require.resolve` も元の release の中を指した**。

裏返しが上記の保持ルールである — **稼働中 release を prune すると、まだ
起こっていない codex spawn の解決が壊れる**。

#### 適用範囲(2026-08-16 時点)

**「atomic switch は Linux 限定」は誤り**なので、層で切り分ける。

| 層 | 適用範囲 |
|---|---|
| release layout (`releases/<id>/` + `current` / `previous`) | **OS 共通** |
| install / switch スクリプトと、symlink + `rename(2)` の atomicity | **OS 共通の契約**。Linux で実測。**macOS は未実測** |
| service-manager orchestration (stop → pointer swap → start、self-stop-safe updater) | **Linux / systemd のみ** |

`rename(2)` の atomicity は POSIX の要求であって Linux 固有ではない。
`mv` を避けたのも移植性のため — GNU の `mv -T` は BSD / macOS に無い。
したがって switch script は移植可能な設計だが、**macOS 上では
operationally unverified** である。launchd には `systemd-run` 相当が無く
(`launchctl submit` / 別 LaunchAgent + `kickstart` で代替する必要がある)、
実機がないため acceptance を満たせない。macOS 版の orchestration は後続
issue に切り出す。

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
