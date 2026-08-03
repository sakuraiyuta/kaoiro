---
title: persona 取り込みディレクトリの extraction cache 外部化
status: accepted
date: 2026-08-03
opened: 2026-08-03
supersedes: []
superseded_by: null
related_specs: [persona-pack-schema, deployment]
related_adrs: [29, 45]
---

# ADR-0046 — persona 取り込みディレクトリの extraction cache 外部化

## Status

Accepted (2026-08-03、マスター委任のクロエ + ふじ協議で決定)。
[ADR-0029](0029-persona-server-sot-and-pack-distribution.md) F2 / F6 の
cache 記述を部分改訂する。

## Context

kaoiro issue #183。`PersonaAssets.build/0` は
`<KAOIRO_PERSONA_DIR>/.cache` へ `mkdir_p!`・zip 展開・stale 削除を行う。
これは compose の `:ro` overlay 例と矛盾しており、`:ro` の persona
dir では cold start が壊れる。問題は ADR-0045 のレビュー中に発見された。

## Decision

### F1: cache root は persona dir の外へ分離する

新設 env `KAOIRO_PERSONA_CACHE_DIR` で cache root を指定する。未設定時は
`System.tmp_dir!()` 配下の
`"kaoiro-persona-cache-<sha256(Path.expand(persona_dir)) の先頭16hex>"` を
既定とする。cache は zip から再生成可能な派生物であり、tmp 消失は許容する。
相対 path や cwd の差で namespace が揺れないよう、hash は expand 後の path
から取る。

### F2: persona dir への書き込みを全廃する

`PersonaAssets.build/0` は persona dir に書き込まない。
`PersonaWatcher.init` の `mkdir_p!` も撤去する。取り込みディレクトリが
欠落している場合は warn を出し、空 manifest で起動して watch を無効にする。
ディレクトリ作成後の有効化には再起動が要る。

### F3: reclaim は cache-key 形式の entry に限定する

reclaim は 16 hex の cache-key 形式に一致する entry だけを削除する。誤って
指定した root 配下の無関係なディレクトリを保護する。

### F4: cache の失敗契約を分ける

cache root を cold start 時に作成または書き込みできない場合は fail-fast で
raise する。稼働中の rebuild で失敗した場合は、現 manifest を
last-known-good として維持する。

cache volume 障害として rebuild 失敗に分類する POSIX atom は、`:erofs` /
`:enospc` / `:edquot` / `:eio` / `:eperm` / `:emfile` / `:enfile` / `:enomem` /
`:enodev` / `:estale` とする。cold start では raise、稼働中は
last-known-good を維持する。`:eacces` は `:zip.unzip` が ingest dir の zip も
読むため両義的であり、error term 内の path が cache root 配下の場合だけ cache
障害と分類する。

アーカイブ形状に由来する `:enotdir` / `:eloop` / `:eisdir` / `:einval` /
`:enoent` は pack error として skip する。たとえば entry `a` と `a/b` が衝突
する zip や、`sprites` を通常ファイルとして持つ zip が該当する。

### F5: 同一 persona dir の複数 process 共有は保証外とする

同一 persona dir を複数 server process が共有する構成は保証しない。
その場合は process ごとに異なる `KAOIRO_PERSONA_CACHE_DIR` を指定する。
compose は `/var/lib/kaoiro/persona-cache` を設定する。

### F6: 既定 tmp root は予測可能な共有 path として harden する

既定 root にだけ `File.chmod` で `0o700` を設定する。chmod が非所有者では
`:eperm` となることを、実質的な所有権チェックとして使う。root は lstat し、
symlink なら拒否する。write probe は `:write + :exclusive` の O_EXCL で作る。
この lstat symlink 拒否と O_EXCL write probe は、既定・明示指定 root の両方に
適用する。

明示指定 root は安全性判断を operator へ委譲する trust boundary とする。server
が勝手に chmod すれば shared volume や orchestrator の設定を壊しうるため、
明示 root を強制 chmod しない。group/world-writable の明示 root は警告のみを
出す。警告は `(root, mode)` ごとに 1 回だけに dedup し、常時 warn を避ける
(ADR-0045 F5 と整合)。

これは予測可能な共有 `/tmp` path に対する先回り攻撃、すなわち symlink を
使う truncate や偽 pack 混入による prompt injection を緩和するためである。

### F7: zip slip を展開前に reject する

zip の全 entry 名を展開前に `Path.safe_relative/1` で検証する。拒否される名前が
1 つでもあれば、その pack 全体を reject し、展開を開始しない。

cache が認証 DETS 台帳と同じ `/var/lib/kaoiro` volume に移ったことで、path
traversal の影響範囲は広がる。OTP 自身の `:zip.unzip` も Illegal path を拒否する
(OTP 29.0.2 で実測)が、実装詳細に依存しない多層防御と、書き込み開始前の拒否を
得るために事前検証を置く。

## Consequences

### Positive

- persona dir を読み取り専用で mount しても cold start できる。
- persona pack の正本と、再生成可能な展開物の書き込み先が分離される。
- cache root の作成不能は起動時に明確に失敗し、稼働中の一時失敗では既存の
  manifest を保つ。

### Negative

- cache root 用に writable volume または tmp 領域が別途必要になる。
- 同一 persona dir を複数 process が共有する運用では cache root の分離を
  運用者が担保する必要がある。
- アーカイブ形状由来の errno を cache 障害側に誤分類すると、ingest dir に
  ファイルを置くだけで cold start を raise させる可用性 DoS になる。

### Neutral

- tmp 配下の既定 cache は消失しても、次の取り込みで zip から再生成される。
- 取り込みディレクトリの欠落は empty manifest と watch 無効で表現し、
  再起動まで自動復帰しない。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| 既定を `<persona_dir>/.cache` のまま compose のみ変更 | custom `:ro` dir の既定動作にバグが残る |
| cross-process safe な atomic cache | 内輪運用には過剰 |
| 起動時に書込可否で分岐 | 挙動が環境依存になり、予見性を失う |
