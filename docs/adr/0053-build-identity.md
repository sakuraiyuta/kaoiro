---
title: build identity を導入し protocol version と分離する
status: accepted
date: 2026-08-12
opened: 2026-08-12
supersedes: []
superseded_by: null
related_specs: [deployment, protocol]
related_adrs: [15, 18, 23]
---

# ADR-0053 — build identity を導入し protocol version と分離する

## Status

Accepted

## Context

稼働中の artifact がどの commit 由来かを言う手段が無かった
([issue #228](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/228))。
server の router に health / version endpoint が無い、`runner` に
`--version` が無い、`server/Dockerfile` に OCI label が無い、runner の
register payload に build revision が無い — いずれも欠けていた。

ファイルの mtime を代用に使いかけたが、これは成立しない。`dist`
ディレクトリの mtime はファイルの追加/削除が無ければ更新されず、実際に
「3 パッケージが 10 日前のまま」と誤読しかけた事例が
[issue #227](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/227)
の runbook に記録されている(4.5 節)。

既存資産として `scripts/build-runner-tarball.sh` は git short SHA と
dirty マークを `VERSION` へ書いていたが、full SHA 化と dirty 定義の統一が
必要だった。

**[ADR-0015](0015-protocol-version-stamping.md) の protocol version は
wire protocol の互換性であって、artifact の identity ではない。**
両者は別軸であり、混同すると「docs-only commit で互換性エラーが出る」
ような誤った設計になる。

## Decision

protocol version と分離した **BuildInfo**(`revision` / `dirty` /
`built_at`)を導入する。`revision` と `dirty` が identity、`built_at` は
診断専用でどこにも比較に使わない。

### dirty の定義(単一箇所)

`git status --porcelain` ベースで判定し、**tracked と untracked の両方**
を dirty とみなす。`git diff --quiet` は untracked を見ないため、
issue #227 の実際の作業で untracked ファイルが既存の dirty 判定を
すり抜けた実例がある。

この判定は **`runner/scripts/generate-build-info.mjs` 一箇所だけ**が行う。
`scripts/build-runner-tarball.sh` は自前で `git diff --quiet` を呼ばず、
この script が書いた `dist/build-info.json` を読んで `VERSION` を組み立てる
— 二重実装によって定義が食い違うリスクを構造的に閉じる。

### runner: build 時に `dist` へ焼き込む(起動時に git を呼ばない)

runner は git 無しの tarball としても配布される
([ADR-0018](0018-runner-distribution.md))。配布後の runner は起動時に
`git rev-parse` を実行できない。加えて repo-direct 運用でも、
`dist` が古い commit のまま `HEAD` だけ進んでいる状態は普通に起きる —
起動時に `git rev-parse HEAD` を報告すると、**実際に動いている artifact
とは無関係な値**を build revision として名乗ってしまう。これは issue #227
の runbook が指摘した「mtime は成功根拠にならない」と同じ構図で、
「いつ書かれたか」ではなく「どの commit 由来か」を問う #228 で同じ穴を
再現してはならない。

よって revision は **build 時**(`pnpm -C runner build` の一部として
`tsc` の直後に `generate-build-info.mjs` が実行される)にのみ計算し、
`dist/build-info.json` として `dist/` の中へ焼き込む。`cli.ts` は
起動時にこのファイルを読むだけで、git を一切呼ばない。repo-direct
実行と tarball 配布のどちらでも同じ経路になる。git が使えない/リポジトリ
外であれば `revision: "unknown"` に fail-soft する — 起動を止めない。

### server: build arg 経由で OCI label + 実行時 env へ

`.dockerignore` は `.git` を build context から除外している(「nothing in
the build reads it」というコメントどおり)。したがって Dockerfile 内で
`git rev-parse` はできず、**build する側が `KAOIRO_BUILD_REVISION` を
build arg として渡す**しかない
(`KAOIRO_BUILD_REVISION=$(git rev-parse HEAD) docker compose build`)。

`KAOIRO_PLAIN_HTTP` と同じ ARG/ENV パターンを踏襲するが、1点異なる:
build_revision は operator が都度指定する値ではなく build 時に確定する
値なので、`KAOIRO_PLAIN_HTTP` のように docker-compose 側で改めて渡す
必要はなく、final stage の image に焼き込んで終わりにする
(`ARG KAOIRO_BUILD_REVISION=unknown` → `ENV` → `LABEL
org.opencontainers.image.revision`)。`GET /api/health` が
`System.get_env("KAOIRO_BUILD_REVISION")` を読んで返す。

`mix phx.server` のローカル起動(Docker を介さない開発時)では
`"unknown"` を返す。git フォールバックは持たせない — runner と同じ理由
(dev の checkout state と起動中の artifact は無関係)。**dev で
`"unknown"` が出るのは正常**とし、この非対称性のおかげで**production で
`"unknown"` が出たら異常**と判定できる。

### SHA 不一致は observability に留め、reject しない

**git SHA の不一致を runtime handshake で reject してはならない。**
docs-only commit、backport、rolling window のいずれでも SHA は正当に
食い違う。SHA は observability に留め、「同一 SHA」は deploy の
postcondition として扱う(既に接続済みの runner と server が異なる SHA
を名乗っていても、通信そのものは拒否しない)。

互換性を弾く必要があるなら、protocol の compatibility epoch / range か
capabilities を別に持つ。ADR-0015 の `version=0` warn-and-accept を
artifact SHA の代用にしない。

`"unknown"` / dirty を拒否する enforcement は本 ADR / #228 のスコープに
含めない — identity の導入と、それを使った enforcement は分ける
([issue #230](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/230)
のスコープ)。#228 に enforcement を混ぜると、dev 環境で server が
起動しなくなるリスクを抱える。

### dashboard: mismatch と unknown の両方を operator へ警告

接続中 runner の `build_revision`(register payload 経由)と server 自身の
`build_revision`(`GET /api/health`)を比較し、不一致のときだけでなく
**runner 側 unknown / server 側 unknown のときも**警告する
(`LaunchDialog` のホスト選択直下)。observability only — 起動をブロック
しない。

## Consequences

- runbook (issue #227, `docs/specs/deployment.md` 4.5) の「証明できない
  こと」節は、full SHA を返す health endpoint と runner の register 情報
  による確認へ置換された。
- `scripts/build-runner-tarball.sh` の VERSION ファイルは full SHA 化され、
  dirty 判定の計算元が `dist/build-info.json` 一本化された(起動シムの
  変更は不要 — `cli.ts` が `dist/build-info.json` を直接読むため)。
- server の deploy には `KAOIRO_BUILD_REVISION` を明示的に渡す一手間が
  増える(`docs/specs/deployment.md` 4.3)。渡し忘れは `"unknown"` として
  observable になるだけで、build 自体は失敗しない。
- `unknown` / dirty の enforcement(production build の拒否ロジック)は
  意図的に本 issue に含めていない — 別 issue (#230) の責務として残る
  未解決事項。

## Alternatives Considered

- **起動時に `git rev-parse` を呼ぶ**: repo-direct 運用でも tarball
  配布でも「動いている artifact と無関係な値」を報告しうるため却下
  (Decision 参照)。
- **`KAOIRO_BUILD_REVISION` を `.env` へ永続化する**: docker-compose の
  `.env` は build 引数の変数展開とコンテナ実行時 env の両方に使われる
  共有ファイルであり、そこに一度書いた値は次の build でも古いまま残り
  うる — 実際に build した SHA と `.env` の値がずれた状態で `/api/health`
  が古い値を報告するリスクを抱える。`KAOIRO_BUILD_REVISION` は build
  実行のその場限りの環境変数として渡す一回性の値とし、`.env.example`
  にも載せない。
