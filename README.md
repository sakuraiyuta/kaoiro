# kaoiro(顔色)

複数の CLI AI エージェント(Claude Code など)の**状態と進捗を監視し、
キャラクターとして可視化する**システム。

文字ベースの CLI エージェントは、いま何をしているか・誰が手待ちなのかを
把握しづらく、親しみも湧きにくい。kaoiro はエージェントを「顔色」で見せ、
複数同時運用時の状況把握と愛着の両方を狙う。

## ステータス

Phase 1.5(トレーサーバレット)まで完了。ラッパー(`wrapper/`)・最小
Phoenix サーバ(`server/`)・最小 Web 表示の縦串が動作し、共通プロトコルは
確定済み([docs/specs/protocol.md](docs/specs/protocol.md))。現在は
Phase 2(キャラ表示)に着手中。最新の進捗は
[docs/plans/](docs/plans/) を参照。

## 全体像

3層構成:

- **ラッパー(Wrapper)** — エージェントを起動し、入出力を仲介。Claude Code は
  公式の **Claude Agent SDK** をホストして観測・制御・権限ルーティングを行い、
  エージェント固有の出力を共通イベント形式へ翻訳する。プラグインで拡張する。
- **サーバ(Server)** — 複数のラッパーを集約し、状態を保持してクライアントへ
  realtime 配信。指示を該当エージェントへルーティングする。
- **クライアント(Client)** — 各エージェントの状態をキャラ絵・表情で可視化する
  Web フロント。

## 技術スタック

- **ラッパー: TypeScript + Claude Agent SDK**(`@anthropic-ai/claude-agent-sdk`)
  - 各エージェントと同居してローカル動作。観測+制御+権限承認を SDK 1経路で。
- **サーバ: Elixir / OTP + Phoenix**
  - WebSocket(Phoenix Channels)で各ラッパーを集約
  - 1 接続(エージェント)= 1 GenServer で最新状態を保持、Supervisor 配下で監視
  - PubSub で fan-out、クライアントへ realtime 配信
- **クライアント: Web フロント(TypeScript)**(描画は静的差分 — `docs/adr/0004-client-rendering-staged.md`)

## 当面の対象

Claude Code を最初の対象とする。他エージェント(Codex 等)は将来、
**アダプタ・プラグイン**として追加する(`docs/specs/plugin-model.md`)。

## 開発(ローカル起動)

全層(サーバ + ダッシュボード + ラッパー)をホットリロード/watch 付きで
一括起動する:

```sh
./scripts/dev.sh
```

`server/.env` を読み込み(`KAOIRO_CLIENT_TOKENS` 必須)、Phoenix(:4000)・
Vite ダッシュボード(:5173, HMR)・ラッパー各エージェント(`tsx watch` で
`agent.*.json` ごとに自動再起動)を起動し、Ctrl-C で一括停止する。env・
トークン設定や各コンポーネントの個別起動は
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

Phase 2: **クライアント + キャラ + 状態ベース表情**。リファレンス
ダッシュボード(Svelte)でエージェントをキャラ絵表示し、状態を表情へ
マッピングする
([docs/plans/phase-2-client-character.md](docs/plans/phase-2-client-character.md))。

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
