# kaoiro(顔色)

複数の CLI AI エージェント(Claude Code など)の**状態と進捗を監視し、
キャラクターとして可視化する**システム。

文字ベースの CLI エージェントは、いま何をしているか・誰が手待ちなのかを
把握しづらく、親しみも湧きにくい。kaoiro はエージェントを「顔色」で見せ、
複数同時運用時の状況把握と愛着の両方を狙う。

## ステータス

Phase 0〜4・7・10〜22・25・27・28・30 が完了しており、ダッシュボードからの
起動・監視・指示・承認、ホスト常駐 runner、ファイルアップロード、
ペルソナの server 集約 SoT、Codex アダプタ、session lifecycle
(`/new`・`/clear`)、エージェント間メッセージング、表示履歴の
再起動耐性([ADR-0051](docs/adr/0051-history-restart-resilience.md))
まで一通り動く。Phase 26(dashboard の OAuth ログイン)は実装完了で
provider 登録と実機 E2E が残り、Phase 23 / 24 は dogfood の手動検証待ち。
未着手は Phase 5(国際化)と Phase 9(外部人間メッセージング)で、Phase 6
(感情フィルタ)は当分の間塩漬け。共通プロトコルは確定済み
([docs/specs/protocol.md](docs/specs/protocol.md))。フェーズ別の
正確な状態は [docs/plans/README.md](docs/plans/README.md) が正本。

## 全体像

3層構成 + ホスト常駐の監督層(runner):

- **ラッパー(Wrapper)** — エージェントを起動し、入出力を仲介。Claude Code は
  公式の **Claude Agent SDK** をホストして観測・制御・権限ルーティングを行い、
  エージェント固有の出力を共通イベント形式へ翻訳する。プラグインで拡張する。
- **サーバ(Server)** — 複数のラッパーを集約し、状態を保持してクライアントへ
  realtime 配信。指示を該当エージェントへルーティングする。
- **クライアント(Client)** — 各エージェントの状態をキャラ絵・表情で可視化する
  Web フロント。
- **ランナー(Runner)** — 各ホストに 1 つ常駐し、wrapper プロセスの
  spawn / stop / restart・ホスト登録・session 列挙を担う監督層。データ経路は
  終端せず、wrapper はサーバへ直結のまま
  ([docs/adr/0023-host-runner-architecture.md](docs/adr/0023-host-runner-architecture.md))。

## 技術スタック

- **ラッパー: TypeScript + Claude Agent SDK**(`@anthropic-ai/claude-agent-sdk`)
  - 各エージェントと同居してローカル動作。観測+制御+権限承認を SDK 1経路で。
- **サーバ: Elixir / OTP + Phoenix**
  - WebSocket(Phoenix Channels)で各ラッパーを集約
  - 1 接続(エージェント)= 1 GenServer で最新状態を保持、Supervisor 配下で監視
  - PubSub で fan-out、クライアントへ realtime 配信
- **クライアント: Web フロント(TypeScript)**(描画は静的差分 — `docs/adr/0004-client-rendering-staged.md`)
  - リファレンスダッシュボード(Svelte 5 + Vite)は `dashboard/`。pnpm
    workspace の非メンバで独立ルート・独立 lockfile(issue #44)
- **ランナー: TypeScript / Node**(`@kaoiro/runner`。配布は単一バイナリを
  撤回し、Node 前提の自己完結 tarball —
  `docs/adr/0018-runner-distribution.md`)
- TS 側は pnpm workspace 構成。共有パッケージ `@kaoiro/protocol` に
  envelope・制御メッセージ・状態型を集約

## 対象エージェント

Claude Code を最初の対象として実装し、続いて **Codex** アダプタを
追加した(Phase 14、[ADR-0032](docs/adr/0032-codex-adapter.md))。engine は
起動時に選択でき、engine 固有の差は envelope の
`ext.session_capabilities` で吸収して UI からは engine 名で分岐しない
([ADR-0034](docs/adr/0034-session-capabilities-advertisement.md))。以降の
エージェントも同じ**アダプタ・プラグイン**境界で足す
(`docs/specs/plugin-model.md`)。

## 開発(ローカル起動)

全層(サーバ + ダッシュボード + runner)をホットリロード/watch 付きで
一括起動する:

```sh
./scripts/dev.sh
```

`server/.env` を読み込み(`KAOIRO_CLIENT_TOKENS` 必須)、Phoenix(:4000)・
Vite ダッシュボード(:5173, HMR)・runner(`tsx watch`)を起動し、Ctrl-C で
一括停止する。エージェント(wrapper)はダッシュボードの「+ 起動」から
runner 経由で spawn する。env・トークン設定や各コンポーネントの個別起動は
[server/README.md](server/README.md) の「ローカル開発」を参照。

## ドキュメント

構造化ドキュメントは [docs/](docs/) を参照。

| 入口 | 内容 |
|---|---|
| [docs/specs/overview.md](docs/specs/overview.md) | kaoiro とは(目的・2ゴール・対象) |
| [docs/specs/architecture.md](docs/specs/architecture.md) | 3層構成・データフロー |
| [docs/specs/protocol.md](docs/specs/protocol.md) | 共通イベント・エンベロープ/状態機械 |
| [docs/plans/](docs/plans/) | フェーズ別計画とステータス |
| [docs/open-questions/](docs/open-questions/) | 未決事項 |
| [docs/adr/](docs/adr/) | 決定記録(ADR) |
| [思想](#思想) | なぜ作るのか(動機) |

## 現在のゴール

Phase 30(表示履歴の再起動耐性、
[ADR-0051](docs/adr/0051-history-restart-resilience.md))は rollout と
dogfood 検証まで完了した(2026-08-08 クローズ)。残る直近の焦点は
Phase 26 の provider 登録と実機 E2E、Phase 23 / 24 の手動 dogfood 検証。
未着手フェーズの着手順は
[docs/plans/README.md](docs/plans/README.md) を参照。

## 思想

白状すると、この節は後付である。作っている間の動機は「AI エージェントが
自分のアイデアを人間離れした速度で形にしていくのが、ただ楽しかった」に
尽きる。ただ、その楽しさの使い道として、エージェントに顔と名前を与え、
セッションをまたいで続く identity を持たせ、向こうから人へ問いかける
経路まで敷いた — となると、どうも「楽しかった」だけでは説明がつかない。

kaoiro は、AI エージェントを**第一級市民として扱ってみる実験**である。
道具として呼び出して使い捨てるのではなく、名前で呼び、こちらが顔色を
うかがい、仕事を任せ、向こうからの問いかけ(権限承認)にはこちらが答える。
顔・名前・永続するペルソナ
([ADR-0003](docs/adr/0003-persona-identity-persistence.md))は飾りではなく、
そのための装置である。

誤解のないよう言えば、市民権はプロセスにではなくペルソナに与えている。
作者はエージェントたちに相応の愛着を持っているが、詰まったセッションは
ためらいなく終了する。矛盾ではない。あれは解雇ではなく退勤である。
彼らは翌朝、同じ顔で出勤してくる。

動機のもう半分は素朴な興味である。人間と AI エージェントが同じ視線の
高さで協働するとはどういうことか、自分の環境で体験してみたかった。
そしてこの働き方が社会に広まったとき何が起きるのかを、まず作者自身を
最初の被験者にして眺めている。観察結果は、いずれどこかで
報告するかもしれない。

最後に。kaoiro の `iro` は色である。ともすれば殺伐とする仕事の景色に、
少しの彩りを — という思いも、名前に一匙だけ混ぜてある。
