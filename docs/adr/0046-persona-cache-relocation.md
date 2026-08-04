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

**追補 (issue #195 must-fix 2, 2026-08-05):** staging 領域の孤児 reclaim
(`reclaim_stage_orphans/1`, F9 参照)も同じ原則に従う。対象は F9 が生成
する `.stage-` に続く 22 文字の random suffix(charset `A-Za-z0-9_-`)まで
**厳密に一致**する entry だけであり、正規表現は
`~r/^\.stage-[A-Za-z0-9_-]{22}\z/` — 前方一致(`.stage-` で始まってさえ
いれば良い、という緩い条件)ではない。`.stage-important` や
`.stage-freshtest` のように前方一致はするが厳密な shape に合わない
entry は永続として扱い、reclaim は絶対に削除しない。`$` ではなく `\z`:
Elixir/Erlang `re` は PCRE 流儀で、`/m` 無しの `$` は文字列末尾の直前の
1個の改行にもマッチするため、`.stage-<22文字>\n` という(生成され得ない)
shape が exact-match をすり抜ける穴が内部レビューで見つかった
(2026-08-05、実装側は修正済み、本 ADR の記述が古いままだった点をふじ
round-3 で指摘・修正)。

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

**追補 (2026-08-04): cache slot 操作 (削除・作成・狭窄) の失敗の扱い。**
上記の errno 表は
cache の**読み書き**の失敗を分類するためのものであり、
`<cache_root>/<hash>` の slot 自体の削除・作成・owner-only mode への狭窄
(chmod)ができなかった場合にはそのまま適用しない。

理由: `:eperm` / `:eacces` / `:eexist` / `:enotdir` は、共有 cache root
(明示設定された root は group/world-writable でも警告に留める) に**他の
OS ユーザが slot を 1 つ置いた**だけで発生する。foreign な非空 slot を
除くには二段階の権限が要る — slot 内の子を unlink する権限は slot
ディレクトリ自身の write/execute ビットに依存し、空になった slot 自体を
除く権限は cache root 側に依存する。したがって root が書けても、他ユーザ
所有で write ビットの無い非空 slot は削除できない。これを cache 障害と
分類すると、置かれたディレクトリ 1 つで全 pack の取り込みが止まり cold
start で raise する — ADR-0029「1 本の不正 drop が全体を止めてはならない」
の逆転になる。

したがって slot の削除・作成・mode 狭窄の失敗については、**cache root を
再度 write-probe し**、

- root がまだ書けて、かつ理由が `:eperm` / `:eacces` / `:eexist` /
  `:enotdir` のいずれか → **当該 pack のみ skip** (pack error)
- それ以外 (`:eio` / `:estale` / `:enospc` / `:erofs` 等)、または root
  自体が書けない → **cache 障害** (表どおり)

と分類する。slot 固有の I/O 障害や stale NFS handle は root を無傷で残す
ため、root probe だけを条件にすると「pack が黙って欠けた manifest の公開」
に化ける。errno 表による限定はそのために残す。

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

**追補 (2026-08-04): slot の安全性契約。** slot(`<cache_root>/<hash>`)の
準備・展開は次を満たす。(1) slot root および slot 内部の special type
(symlink 等)は lstat で検出して reject する — 通常ファイル・ディレクトリ
以外を読取り経路が辿ることはない。(2) slot の作成は exclusive な mkdir で
行う(`mkdir_p` 相当は既存 symlink を成功扱いするため不可)。(3) slot は
**展開前に** owner-only(0700)へ狭窄し、展開後は entry の mode を
owner-only へ正規化する — アーカイブが宣言した mode を採らない。これらは
実装詳細ではなく安全性契約であり、緩和は本 ADR の改訂を要する。

### F7: zip slip を展開前に reject する

zip の全 entry 名を展開前に `Path.safe_relative/1` で検証する。拒否される名前が
1 つでもあれば、その pack 全体を reject し、展開を開始しない。

cache が認証 DETS 台帳と同じ `/var/lib/kaoiro` volume に移ったことで、path
traversal の影響範囲は広がる。OTP 自身の `:zip.unzip` も Illegal path を拒否する
(OTP 29.0.2 で実測)が、実装詳細に依存しない多層防御と、書き込み開始前の拒否を
得るために事前検証を置く。

### F8: 展開後サイズとエントリ数を展開前に上限で reject する

pack の展開後合計サイズを **1 GiB (1_073_741_824 byte)**、エントリ数を
**4096 件** に制限する。いずれかを超える pack は展開を開始せず reject し、当該
pack のみ skip する (ADR-0029)。上限超過は errno ではなく明示的な検査結果として
扱い、F4 の errno 分類には影響させない。

上限値は 2026-08-04 にマスターが決定した。1 GiB は高解像度画像および将来の拡張
(3D モデル等) を見込んだ余裕値で、2 進接頭辞 (1024^3) として解釈する。4096 件は
サイズ上限だけでは防げない「合計サイズは小さいが件数のみ膨大な pack」(inode 枯渇・
展開時間攻撃) を塞ぐためのもので、正当 pack (sprite 数十〜3D で数百) を弾かない
余裕を持たせた。ディレクトリ entry も 1 件として数える。

**申告された uncompressed size は使わない。** `:zip.list_dir/1` が返す展開後
サイズは local header と
central directory の申告値であり、攻撃者が自由に書ける。`:zip.unzip/2` はこの申告を
一切参照せず実データを最後まで展開する — OTP 29.0.2 実測で、双方の header に
100 byte と申告した entry がエラーなしで 10,000,000 byte 書き出された。したがって
サイズ上限は、展開前に raw deflate ストリームを実際に inflate して実測する。出力は
書き出さず、64 KiB の固定チャンクで供給して破棄しながら byte 数だけ積算するため、
単一の巨大 entry でもメモリは一定である。上限到達時点で即中断するので、展開時間
攻撃も同時に緩和される。

この決定は issue #189 の当初案 (「`:zip.list_dir/1` が展開後サイズを返すので
それを検査する」) を実測により棄却したものである。将来「list_dir で足りるのでは」
と戻されないよう、棄却の根拠をここに固定する。

**method と flag は local header を正本とする。** OTP 29.0.2 実測で、`:zip.unzip/2`
は local header の compression method で展開する (central が STORE・local が DEFLATE
の entry は inflate され、逆は拒否された)。central から method を読む実装は申告
サイズと同型の bypass になるため、central の method は参照しない。暗号化 entry
(general purpose bit 0) は inflate で実量を測れないため reject する — 同 OTP は
暗号化ビットを無視して暗号文をそのまま書き出すため、素通しにはできない。DEFLATE と
STORE 以外の method も同様に reject する。

**data descriptor (general purpose bit 3) は central directory の comp_size で
測る。** bit 3 が立つ entry は local header の size が placeholder であり、OTP は
central directory の comp_size を読んで展開する (stdlib 8.0.1 `zip.erl`
`get_z_file/9`: `GPFlag band 8 =:= 8 -> ZipFile#zip_file.comp_size`)。したがって
実測の読み取り span もそこから取る。local header だけを読む実装は当該 entry を
0 byte と数えて上限検査を素通りさせる — local に csize 0、central に真値を書いた
zip で、実測は 0 byte、`:zip.unzip/2` は 10,000,000 byte を書き出した (実測)。
bit 3 は streaming zip writer (Java `ZipOutputStream`、Go `archive/zip` 等) が
日常的に立てるため reject はせず、extractor と同じ field を読む。判定に使う flag
自体は local header 側から取る (これも `get_z_file/9` と同じ) ので、central だけに
立てた flag で信頼先を切り替えることはできない。

**ZIP64 の sentinel は local の extra field で解決する。** 32-bit の size field が
`0xffffffff` のとき、実サイズは ZIP64 extended information extra field
(id 0x0001) にある。bit 3 が無ければ OTP はこれを local 側で解決してから展開する
ため、実測も local extra を読む (central では代用しない — bit 3 なしでは local が
正本であり、central と食い違わせられる)。

読み方は **OTP の `update_zip64/2` と同じループ**でなければならない。この record
は index できる固定レイアウトではなく、8 byte 消費するたびに「その field はまだ
sentinel か」を再評価する。64-bit 値それ自体が `0xffffffff` のとき OTP はさらに
8 byte を同じ field として消費するため、固定位置で読むと comp_size を 1 つ手前
から取る。実測 (テストは検証を現実的な規模で行うため縮小した上限を使う): payload
の 64-bit field を 3 つ並べた形に対し、固定位置版は 2 つ目の値を comp_size と
誤読して極小の値を測る一方、`:zip.unzip/2` は 3 つ目を正本として読み、1 MB の
展開を行った。テスト上は 999,999 byte 上限を bypass する形で固定してある。
比率がそのまま拡大するため、同じ構成を 1 GiB 超の展開量へスケールでき、
production の上限も同型で bypass される。

以上より、compressed size の正本は次の優先順で決まる。bit 3 あり → central
directory の comp_size / bit 3 なしかつ 32-bit が sentinel → local ZIP64 extra
(上記ループで解決) / それ以外 → local header の 32-bit field。

**列挙そのものを列挙前に bound する。** 上記のサイズ・件数検査はいずれも
`:zip.list_dir/1` の結果に対して働くが、その `list_dir` 自体が bound されて
いなければ意味を成さない。OTP は central directory を全件 materialize する
ため、1 GiB のアーカイブは数 GB の BEAM heap を要求しうる (実測: 40 万 entry
で 203 MB / 5.7 秒)。よって EOCD (end of central directory) を `list_dir` の
**前に**読み、3 つの申告値で bound する。いずれも「申告が上限を超えるなら
弾く」方向にのみ使い、申告を信じる方向は持たない。

| 申告値 | なぜ bound になるか |
|---|---|
| entry 数 | `get_central_dir/4` が `N = EOCD#eocd.entries` を `get_cd_loop/6` のループ回数へそのまま渡す (stdlib 8.0.1 `zip.erl` 1916-1921)。過小申告は列挙を**減らす**だけで増やせない (実測: 40 万件を持つが 10 と申告したアーカイブは 1ms で列挙が終わる。`list_dir` の戻りは 11 要素だが、内訳は `:zip_file` 10 件 + `:zip_comment` 1 件で、entry 数上限が数えるのは前者のみ)。過大申告はファイルが尽きて `bad_central_directory` を throw する |
| `filesize - 申告 central offset` | `get_cd_loop/6` は申告 offset へ seek して前進 read しかしないため、列挙が触れうるバイト数の上限になる。offset の過小申告はこの span を**大きく**するので早く弾かれ、過大申告は seek 先にレコードが無く throw する |
| ZIP64 record の申告 body 長 | `find_eocd64/5` は locator 先の 12 byte を読んだ後、**central offset を得る前に**申告バイト数を read する (`zip.erl` 2121-2138)。この段を bound しないと、record をファイル前方に置いて巨大な body 長を申告しつつ central offset を EOF 近くに申告することで、span 検査が通る時点では read が既に終わっている |

**申告された central directory サイズは使わない。** OTP はこの field を
どこでも読まないため、bound しても何も bound しない。

**上限は 1 本の予算 4 MiB (`@max_entries * 1024`)。** 健全な pack の central
directory は 4096 件上限でも約 800 KB (固定 46 byte + name 100 前後 +
extra 30 前後) なので約 5 倍の余裕がある。central directory tail と ZIP64
record の申告長を**合算して**この 1 本に充てる — 領域ごとに別枠にすると同じ
上限を二重に使えてしまうし、「列挙にいくらかかりうるか」という問いは元々
合計に対する問いである。

**entry 数だけでは塞がらない。** `get_cd_loop/6` は 1 件ごとに
name + extra + comment を read し、3 つとも 16-bit 長なので 1 entry で最大
192 KB 引ける。さらに OTP は name と comment を charlist で返すため、64-bit
VM では 1 文字 16 byte に膨らむ。実測 (OTP 29.0.2): 64 KB の name を持つ
500 entry はディスク上 31 MB に対し heap 516 MB、増幅 16.5 倍。entry 数上限
まで外挿すると 268 MB の pack が約 4.2 GB を要求し、**1 GiB のアーカイブ
上限にも 4096 件の entry 上限にも触れない**。span の bound はこの経路を
塞ぐためのもので、4 MiB では同じ増幅率で約 66 MB に収まる。

**EOCD の探索手順は OTP を写す。** 独立実装は decoy を仕込まれたときに採用
位置が食い違う。OTP は `eof - window` から**前方へ** 1 バイトずつ走査して
最初の構造マッチを採り、外れたら window を倍化する (22 → 44 → ... →
min(0xffff+42, filesize))。慣例的な後方走査は最後のレコードを採るため、
両者は別の EOCD を根拠にしうる。locator 有りの節だけ `entries_on_disk` と
`entries` を AND で結合する非対称も含めて写す。定数は ZIP 仕様上のフィールド
幅ではなく **OTP のマクロ値**を採る — locator は物理 20 byte だが
`?END_OF_CENTRAL_DIR_64_LOCATOR_SZ` は `(4+8+4)` = 16 であり (`zip.erl`:253)、
実装はその値で動く。仕様側の 20 を採ると探索窓が OTP より 4 byte 広くなり、
OTP が決して見ない位置の decoy を先読みだけが採用して 3 本の bound が同時に
無効化される (実測で再現)。走査窓そのもの (倍化ループ全体で最大約 131 KB) は
攻撃者がスケールできないため予算の対象外とする。

**STORE の境界はアーカイブ自身のサイズで与える。** DEFLATE は stream 終端で実測が
閉じるが、STORE には終端が無く、その長さは偽装可能な申告フィールドにしか存在しない。
偽装できないのはアーカイブのファイルサイズであり、STORE は膨張しないため、アーカイブ
自体を同じ 1 GiB 上限で縛れば STORE 由来の展開量も必ず上限内に収まる。会計上は
STORE entry を上記の優先順で決まった comp_size で加算する。過小申告は bypass に
ならない — 展開側も同じ comp_size 分しか読まないため実書き込みも同じだけ減る
(local と central の**双方**で csize を 0 とした data descriptor 形は、OTP が
アーカイブごと拒否することを DEFLATE / STORE 双方で実測。central に真値が残って
いれば展開されるため、bit 3 entry の comp_size は上記のとおり central を正本と
する)。

**検査順序は cheap reject 優先とする。** アーカイブサイズ → central metadata の
preflight (entry 数 / span / ZIP64 body 長。`:zip.list_dir/1` より前) → zip slip /
local header 整合 (F7) → inflate 実測。名前だけで reject できる traversal 付き
zip bomb に、最大 1 GiB 分の inflate CPU を払わせないためである。F7 と本検査は
いずれも書き込みを一切行わない層であり、この不変条件は順序の変更に依らず維持する。

### F9: preflight と展開の TOCTOU を staging で閉じる (issue #195, ふじ 2026-08-05 spec)

F7 / F8 の preflight (`verify_archive/1`) と `:zip.unzip/2` は、当初どちらも
ingest writer が制御できる `zip_path` を独立に開いていた — 検査本体だけでも
`:zip.list_dir/1` を 2 回、`File.open(raw)` を複数回、展開側の
`:zip.unzip/2` を含めると同一パスを合計 5 回以上開き直す。両者が同一バイト列
である保証は無く、ingest dir に書ける主体は検査通過後・展開開始前に別の
archive へ差し替えることで F7 / F8 双方の検査を無効化できた
(旧 Negative 記載、下記で解消)。

**検討した対処案。** (a) 一度読んだ binary を preflight と展開の双方へ渡す —
上限が 1 GiB である以上、一括 read は現行の 64 KiB streaming 設計 (F8) を
破りそれ自体が新規メモリ DoS になるため却下。(b) preflight 直後の再ハッシュ —
窓を狭めるが塞がないため却下。(c) OTP `:zip.zip_open/2` の fd 保持 API を
使い切る — `zip_open` はパス指定時に 1 回だけ `file:open` し以後の
`zip_get`/`zip_list_dir` は同一 fd の pread/read のみで再オープンしないこと
を stdlib 8.0.1 ソースで確認したが、`zip_get/1` (memory オプション無し) は
各 entry を直接ディスクへ書く設計で「展開後サイズだけ測って中身は保持しない」
ができない。F8 の streaming inflate 測定をこの API 経由で作り直すか
`:zip.unzip/2` 自体を自前実装へ置き換える必要があり、本 issue の severity
(Low) には過大と判断し不採用(将来 severity が上がれば再検討の余地あり)。

**採用した方式。** ingest から読んだ archive を、ingest writer が触れない
trusted cache root 配下の private な staging 領域(exclusive mkdir 0700 の
一時 dir + exclusive create 0600 のファイル、basename は collision 回避
専用の random 値で security boundary ではない)へ、source を **1 回だけ
open** した fd から 64 KiB チャンクで **bounded copy**(上限 `limit + 1`
byte — ちょうど上限と上限超過を区別するための 1 byte で、それ以上は読まない)
する。copy と同じパスで SHA-256 を計算し、**staged 側の full digest** と
**識別用に事前計算していた full digest** を照合する。一致しなければ「取り込み
中に source が変化した」と判断し、当該 pack を **race として skip**(malformed
archive とは区別できる文言でログする)し、次の watcher-triggered rebuild に
再試行を委ねる。一致すれば、以降の F7 / F8 preflight と `:zip.unzip/2` は
**staging されたファイルだけ**を見る(元の ingest path には二度と触れない)。

**この方式が保証すること。** open した fd は元の inode に紐づくため、copy
開始後に ingest 側の path が rename/relink で差し替わっても、既に開いている
fd は影響を受けない(POSIX の一般的性質)。**ただし同一 inode への
truncate/上書きは影響を受ける** — copy 完了前に元ファイルの中身が同じ inode
上で書き換わると、staged 側に新旧混在のバイト列が入り得る。この性質は
「fd が source の時点 snapshot を保証する」という意味ではない —
保証しているのは「**bounded copy が生成した、以後変化しない stable な
artifact に対して、preflight と展開が同じものを見る**」という一貫性であり、
仮に混在バイト列が staged されても、F7 / F8 と `:zip.unzip/2` はその
staged artifact 全体に対して一貫して検査・展開するため安全性は破れない
(不正な形であれば reject、正当な形であれば一貫して展開されるだけ)。

**この保証は trust boundary の内側でのみ成立する。** cache root は ingest
writer が書き込めないことが前提 (F6 の trust boundary と同じ前提)。F6 が
述べるとおり、明示指定 cache root を group/world-writable にする運用は
operator の判断に委ねられており、そのような root では staging 領域自体が
ingest writer から到達可能になり得るため、本節の保証は適用されない。

**stage の後始末。** 生成した staging 領域は success / pack error /
cache error / exception raise の全経路で削除する。正常な戻り値
(success / pack error / cache error)は `merge_cleanup_error/2` で
cleanup 結果とマージして返す。`rescue` は例外 (`raise` で送出される
error exception)だけを対象に cleanup 後 `reraise` する — `try`/`after`
ではなく `try`/`rescue` であり、throw / exit はこの層では捕まえない
(それらを含む untrappable な termination は下記の孤児 reclaim が最終
防衛線となる)。

VM crash 等で削除処理自体が走らなかった場合に備え、`.stage-*` の
random suffix まで厳密に一致する命名パターンの孤児を reclaim する
(issue #195 ふじ round-2 レビュー, 2026-08-05)。当初は 10 分の
age-gate で保護していたが、それは `rebuild/0` に global lock が無く、
他の並行 rebuild がまだ使用中の staging 領域を誤って掃除しないための
ものだった。**must-fix 1** で `rebuild/0` 本体を
`KaoiroServer.PersonaRebuildLock` 経由に直列化し、この BEAM node 内で
同時に1本の rebuild しか走らないことを保証したため、`build/1` 開始
時点で live な staging 領域は存在し得ない。したがって age-gate を撤廃
し、`reclaim_stage_orphans/1` の呼び出しを `build/1` の先頭(pack 処理
より前)へ移動、F3 が定める厳密な名前一致の entry を条件なしで即時
reclaim する方式に改めた。

なお `:zip.unzip/2` の entry 列挙元は central directory であることを実測した
(central に載っていない local entry は展開されない)。よって entry 数を central
directory から数えることは、展開側の挙動と一致する。

## Consequences

### Positive

- persona dir を読み取り専用で mount しても cold start できる。
- persona pack の正本と、再生成可能な展開物の書き込み先が分離される。
- cache root の作成不能は起動時に明確に失敗し、稼働中の一時失敗では既存の
  manifest を保つ。
- 1 本の高圧縮 pack で cache volume を埋める攻撃 (zip bomb) を、展開を開始する
  前に遮断できる。cache は認証 DETS 台帳と同一 volume にあるため、これは失効
  ストアの劣化防止でもある (F8)。

### Negative

- cache root 用に writable volume または tmp 領域が別途必要になる。
- 同一 persona dir を複数 process が共有する運用では cache root の分離を
  運用者が担保する必要がある。
- アーカイブ形状由来の errno を cache 障害側に誤分類すると、ingest dir に
  ファイルを置くだけで cold start を raise させる可用性 DoS になる。
- 正当な pack でも展開前に 1 回 inflate するため、展開が実質 2 回分の CPU を
  要する (数 MB の pack では無視できる、F8)。
- 上限内の pack を ingest dir へ大量に並べる攻撃は F8 の範囲外である。cache
  全体の容量管理は別の層で扱う必要がある。
- **`verify_archive/1` は central directory を 2 回 materialize する。**
  検査本体と `verify_entry_names/1` がそれぞれ `:zip.list_dir/1` を呼ぶため、
  列挙コストは 2 回分かかる。2 回は逐次であり 1 回目の charlist は binary 名へ
  変換した時点で到達不能になるので、peak が単純に倍になるわけではない。
  4 MiB の予算により各回はおよそ 66 MB で頭打ちになる。
- **4 MiB を超える central directory を持つ pack は、健全であっても skip
  される。** 予算は実測でも申告値の検証でもなく上限値であり、name や comment
  を極端に長く持つ正当な pack を弾きうる。実在しないと判断してこの方向を選んだ
  (当該 pack のみ skip、ADR-0029)。
- **EOCD の探索窓は予算の外側にある。** 倍化ループは最大約 131 KB を読む。
  OTP 自身が同じ上限で読むため攻撃者にスケールさせられないが、「列挙前に読む
  バイト数はすべて 4 MiB 以内」という言い方は正確ではない。
- ~~preflight と展開の間に TOCTOU がある。~~ **解決済み (F9, issue #195,
  2026-08-05)。** 検査対象を trusted cache root 配下の staging artifact に
  一本化し、staged full digest と識別用 full digest の照合で ingest 側の
  差し替えを race として検出・skip する。保証は trust boundary の内側
  (F6) でのみ成立する — 詳細は F9 参照。

### Neutral

- tmp 配下の既定 cache は消失しても、次の取り込みで zip から再生成される。
- 取り込みディレクトリの欠落は empty manifest と watch 無効で表現し、
  再起動まで自動復帰しない。
- F8 の上限値 (1 GiB / 4096 件 / `@max_central_dir_bytes` 4 MiB) はいずれも
  module attribute の定数であり、環境変数では変更できない。運用上の変更が
  必要になった時点で別 issue とする (issue #189 で決定)。1 GiB と 4096 件は
  マスター決定 (2026-08-04) であるのに対し、4 MiB は製品判断が絡まない内部
  マージンとしてクロエ決定 (2026-08-04) である。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| 既定を `<persona_dir>/.cache` のまま compose のみ変更 | custom `:ro` dir の既定動作にバグが残る |
| cross-process safe な atomic cache | 内輪運用には過剰 |
| 起動時に書込可否で分岐 | 挙動が環境依存になり、予見性を失う |
