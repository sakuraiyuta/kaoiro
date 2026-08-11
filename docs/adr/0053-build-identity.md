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

protocol version と分離した build identity(`revision` / `dirty`、
runner のみ追加で `built_at`)を導入する。`revision` と `dirty` が
identity。

**`built_at` は runner 側のみの診断専用フィールドで、server 側には
持たせない**(issue #228 round 2 advisory 2, ふじ 差し戻し — 「BuildInfo
共通 shape」という書き方は runner の `BuildInfo`(TS 型、
`runner/src/build_info.ts`)を指し、server 側の identity(revision/dirty
の 2 フィールドのみ)とは別物であることを明記する。混同すると、後続
実装が「server にも built_at が要る」と誤読しうる)。`built_at` は
どこにも比較に使わない — 「いつ書かれたか」ではなく「どの commit 由来か」
だけが identity である、という本 ADR の中心的な区別そのものを体現する
フィールドなので、比較に使えばこの ADR 自身の前提と矛盾する。

**`built_at` も値域検証の対象(issue #228 round 3, ふじ 差し戻し MF-4)。**
diagnostic 専用だからといって任意文字列を許容してよいわけではない —
`generate-build-info.mjs` が書く `new Date().toISOString()` の canonical
ISO-8601 形式、または `UNKNOWN_BUILD_INFO` の literal `"unknown"` のみを
正とする。

### dirty の定義(単一箇所)

`git status --porcelain` ベースで判定し、**tracked と untracked の両方**
を dirty とみなす。`git diff --quiet` は untracked を見ないため、
issue #227 の実際の作業で untracked ファイルが既存の dirty 判定を
すり抜けた実例がある。

**round 2 の裁定(ふじ 差し戻し、MF-2):** `git status --porcelain`
自体が失敗した場合(rev-parse は成功したが status が失敗する異常系)、
**identity 全体を `unknown` へ degrade する** — revision は実体のまま
`dirty: false` にフォールバックしてはならない。「判定不能を false へ
degrade する」は「分からないのに大丈夫だと言う」ことになり、「分からない
と言う」(unknown への degrade)とは違う。tri-state 化(dirty を
unknown/true/false の3値にする)は採らない — 状態が
absent/unknown/dirty-unknown/dirty/clean-mismatch/clean-match まで増え、
issue #230 の enforcement 設計を複雑にするだけで得るものが無いため。
degrade した理由は診断のためログへ残す(無言で unknown にしない)。

この計算は **repo-level の `scripts/build-identity.mjs` 一箇所だけ**が
行う(round 1 は runner 側の `generate-build-info.mjs` だけに実装して
いたが、server の build args 計算がここに乗っていなかった —
round 2 でこの一本化を完了した)。`runner/scripts/generate-build-info.mjs`
はこれを import して `dist/build-info.json` を書く。server の build 手順
(`docs/specs/deployment.md` 4.3)も同じ script を呼んで
`KAOIRO_BUILD_REVISION` / `KAOIRO_BUILD_DIRTY` を得る。
`scripts/build-runner-tarball.sh` は自前で `git diff --quiet` を呼ばず、
`generate-build-info.mjs` が書いた `dist/build-info.json` を読んで
`VERSION` を組み立てる(`--format` モード)— 二重実装によって定義が
食い違うリスクを構造的に閉じる。

**round 3 の裁定(ふじ 差し戻し、MF-3): `--format` も同じ値域検証を
かける。** round 2 の `--format` はファイルを読んで整形するだけで
`revision`/`dirty` の値域検証をしていなかった —
`{"revision":"not-a-sha","dirty":"false"}` のような壊れた
build-info.json を渡すと、JS の truthy 判定で文字列 `"false"` が
dirty 扱いされ `not-a-sha-dirty` を平然と出力していた(runner の
`loadBuildInfo()` は同じファイルを `unknown` へ degrade するのに、
`--format` だけ生の値を通す非一貫)。裁定は fail-loud で止めることでは
なく、**runner と同じ `unknown` へ degrade する**こと — 同じファイルに
対して読み手ごとに違う振る舞いを持たせないため。degrade した理由は
(他の degrade 経路と同じく)stderr へ出す。

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

### server: build arg 経由で image 内の image-baked file へ焼き込む

`.dockerignore` は `.git` を build context から除外している(「nothing in
the build reads it」というコメントどおり)。したがって Dockerfile 内で
`git rev-parse` はできず、**build する側が `KAOIRO_BUILD_REVISION` /
`KAOIRO_BUILD_DIRTY` を build arg として渡す**しかない
(`scripts/build-identity.mjs` の出力を `docker compose build` へ渡す —
`docs/specs/deployment.md` 4.3)。

**round 1 は `ARG` → `ENV` → `LABEL` という `KAOIRO_PLAIN_HTTP` と同じ
パターンを踏襲したが、これは round 2 で誤りと判定された(ふじ 差し戻し、
MF-1)。** `ENV` はコンテナ**実行時**に `docker run -e` や
`docker-compose.yaml` の `env_file: .env` で上書きできる — 「name を変え
ただけで、runner で却下したのと同じ取り違えを server 側へ戻した」形に
なっていた: build 時に確定するはずの identity が、実行時に別の値へ
差し替え可能なままだった。`KAOIRO_PLAIN_HTTP` の ARG/ENV パターンを
あえて踏襲しなかった理由(round 1 からの既存の判断)は正しかったが、
「`.env` へ書かない」だけでは「書ける構造」自体は残ってしまっていた。

よって final stage で `ARG` から **image 内の image-baked file**
(`/app/build-info.json`)を生成し、OCI label もこの ARG から生成する
(同一 ARG から生成するので両者は必ず一致する)。`GET /api/health`
(`KaoiroServerWeb.HealthController`)は `System.get_env` ではなく
**この file** を、Mix release が起動時に自動 export する `RELEASE_ROOT`
環境変数(値そのものではなくファイルの所在を指すだけ)から辿って読む。

**用語について(issue #228 round 3 advisory 2, ふじ 差し戻し):**
「immutable」ではなく「image-baked」と呼ぶ。`/app` は `nobody` 所有、
`build-info.json` は `chown nobody:root` — コンテナ内の実行中 process に
対する改ざん耐性(tamper-resistance)は無く、attestation でもない。
保証しているのは「container-RUN-time env からの独立」のみ。

`dirty` も OCI label 化する(`com.kaoiro.build-dirty` — `dirty` は
`org.opencontainers.image.*` の予約語彙に無いため project-custom
label)。round 2 は `build-info.json` へ dirty を焼いたが label 化を
忘れており、`docker inspect` 経由の provenance 確認(deployment.md 4.5)
から dirty が見えなかった(issue #228 round 3 MF-1)。

`mix phx.server` のローカル起動(Docker を介さない開発時)では
`RELEASE_ROOT` 自体が未設定のため `"unknown"` を返す。git フォールバックは
持たせない — runner と同じ理由(dev の checkout state と起動中の artifact
は無関係)。**dev で `"unknown"` が出るのは正常**とし、この非対称性の
おかげで**production で `"unknown"` が出たら異常**と判定できる。

### 値域の検証(round 2, ふじ 差し戻し MF-3)

`revision` は「リテラル `"unknown"`」または「ロワーケース 40 桁 hex の
git SHA」のみを正とする値域とし、`KaoiroServer.BuildIdentity` に一箇所
だけ実装する。server 自身の `build-info.json` 読み取り(HealthController)
と、runner の `register` payload 解析(`RunnerChannel`)の両方がこれを
使う — 型(`is_binary`)だけでは空文字・16進以外の文字・41 桁などが素通り
してしまう。dashboard 側(`protocol.ts`)・runner 側
(`build_info.ts`)は言語境界をまたぐため同じ正規表現を独立に複製するが、
「同じ値域」という取り決め自体は 3 言語で統一する。

`register` の `build_revision` / `build_dirty` は「両方省略」(pre-#228
runner との互換)または「両方提示」のいずれかのみを正とし、片方だけの
提示は register 全体を reject する(型崩れ・値域外と同じ扱い — この
reject は SHA の値そのものへの enforcement ではなく、構造検証)。

### dashboard: mismatch と unknown の両方を operator へ警告

接続中 runner の `build_revision`(register payload 経由)と server 自身の
`build_revision`(`GET /api/health`)を比較し、不一致のときだけでなく
**runner 側 unknown / server 側 unknown のときも**警告する
(`LaunchDialog` のホスト選択直下)。observability only — 起動をブロック
しない。

**round 2 で状態遷移を拡張した(ふじ 差し戻し、MF-4)。** round 1 は
「runner の `build_revision` が absent」と「server 側の health 取得に
失敗」の2状態を**無言で警告なし**にしていた — これは「一致している」と
見分けが付かず、「signal が無い」こと自体を operator へ正直に見せる
という #228 の目的に反していた。round 2 では absent / runner unknown /
server 取得失敗 / server unknown / mismatch / dirty のそれぞれを個別の
文言で表示し、**一致かつ clean のときだけ**無警告にする。

**round 3 で dirty 側の穴が見つかった(ふじ 差し戻し、MF-1)。** round 2
の dirty 判定は runner の `host.build_dirty` しか見ておらず、server 自身
の dirty(`GET /api/health` の `build_dirty`)を dashboard へ渡していな
かった。「server が dirty、runner が clean、revision が一致」する組合せ
で無警告になり、「一致かつ clean のときだけ無警告」という上記の原則と
矛盾していた。dashboard は server の `build_dirty` も受け取り、runner
dirty と server dirty を区別できる文言で警告する。

**round 3 で dashboard 側の pair invariant 崩れも見つかった(ふじ 差し
戻し、MF-2)。** server 側は「両方省略または両方提示」以外を reject する
一方、dashboard の `parseHosts` は `build_revision` / `build_dirty` を
**独立に** copy していた — revision が値域外でも dirty が単独で残る
(またはその逆)。malformed な revision と `dirty: false` の組合せは、
server 側 revision と一致する状況では「一致かつ clean」として無警告に
なりうる、fail-open な偽装経路だった。dashboard の trust boundary でも
pair を一単位として narrow し、両方 valid のときのみ両方を残す。

health は mount 時の 1 回だけでなく、channel の (re)join(server
redeploy 後の再接続を含む)と LaunchDialog を開く直前にも再取得する
(`cache: "no-store"`)。複数の取得トリガーが非同期に競合しうるため、
単調増加する世代カウンタで古い応答による巻き戻りを防ぐ。

### runner の launch shim: `--version` を config チェックより前で転送する

**round 2 で見つかった実装漏れ(ふじ 差し戻し、MF-5):**
`runner/deploy/kaoiro-runner-launch.sh` は config の存在チェックを通ら
ないと entry point へ一切の引数を転送しない構造だったため、
`docs/specs/deployment.md` が謳う「tarball 配布の launch shim 経由で
`--version` を確認できる」は**未設定の初回ホストでは実際には嘘**だった
— config が無いホストほど「このホストは何者としてビルドされたか」を
確認したい局面のはずなのに、確認できなかった。shim は `--version` を
config チェックより**前**に entry point へ転送するよう修正し、
`cli.js --version` / `VERSION` ファイル / `dist/build-info.json` の
canonical form が一致することをテストで pin する。

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

## Consequences

- runbook (issue #227, `docs/specs/deployment.md` 4.5) の「証明できない
  こと」節は、full SHA を返す health endpoint と runner の register 情報
  による確認へ置換された。
- `scripts/build-runner-tarball.sh` の VERSION ファイルは full SHA 化され、
  dirty 判定の計算元が `dist/build-info.json` 一本化された(起動シムの
  変更は不要 — `cli.ts` が `dist/build-info.json` を直接読むため)。
- server の deploy には `KAOIRO_BUILD_REVISION` / `KAOIRO_BUILD_DIRTY` を
  明示的に渡す一手間が増える(`docs/specs/deployment.md` 4.3)。渡し忘れは
  `"unknown"` / `false` として observable になるだけで、build 自体は
  失敗しない。
- `unknown` / dirty の enforcement(production build の拒否ロジック)は
  意図的に本 issue に含めていない — 別 issue (#230) の責務として残る
  未解決事項。
- round 2(ふじ 差し戻し)で以下を修正: server の identity を ENV から
  image 内 image-baked file へ(MF-1)、dirty 判定失敗時の degrade 範囲
  (MF-2)、revision/dirty 計算の repo-level 一本化(MF-2)、value domain
  検証の 3 言語統一(MF-3)、dashboard の警告状態を 2 状態の無言サイレント
  から 6 状態の明示表示へ拡張し health を複数トリガーで再取得(MF-4)、
  launch shim の `--version` 転送順序(MF-5)。
- round 3(ふじ 差し戻し)で以下を修正: server の dirty を OCI label
  (`com.kaoiro.build-dirty`)化し dashboard へ到達させる(MF-1)、
  dashboard `parseHosts` の revision/dirty pair invariant 崩れ(MF-2、
  server の「両方省略または両方提示」規約を dashboard の trust boundary
  でも守る)、`build-identity.mjs --format` の値域検証迂回(MF-3)、
  `built_at` の値域検証(MF-4)、「immutable」→「image-baked」への
  用語訂正(advisory 2)。

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
