export const app = {
  quagmireRally: (p: {
    names: string;
    turns: number;
    conversations: number;
    threshold: number;
  }) =>
    `${p.names} のやり取りが ${p.turns} 通 (${p.conversations} 会話、閾値 ${p.threshold}) に達しました。進捗を確認してください。`,
  quagmireDeliveryGap: "配送確認の遅延が疑われます (期間内に処理完了あり)。",
  quagmireStalled: "停滞の疑いがあります。",
  quagmireUnconfirmed: (p: {
    label: string;
    undelivered: number;
    since: string;
    diagnosis: string;
  }) =>
    `${p.label} 宛のメッセージ ${p.undelivered} 件の配送確認が未完了です (${p.since} から)。${p.diagnosis}`,
  timeUnknown: "時刻不明",
  ceilingNarrow: (p: { axis: string; ceiling: string; current: string }) =>
    `${p.axis} を ${p.ceiling} に狭めてから reset (現在: ${p.current})`,
  ceilingSandboxFixed: (p: { ceiling: string }) =>
    `現在の sandbox は danger-full-access なので network_access は true に固定されています。先に sandbox を ${p.ceiling} に狭めてください。`,
  ceilingNetworkNarrow: (p: { ceiling: string }) =>
    `その後も network_access が上限を超える場合は ${p.ceiling} に狭めてください。`,
  spawnStarted: (p: { label: string }) => `起動しました: ${p.label}`,
  spawnFailed: (p: { label: string; reason: string }) =>
    `起動に失敗: ${p.label} (${p.reason})`,
  terminateFailed: (p: { reason: string }) => `終了できません (${p.reason})`,
  restoreFailed: (p: { reason: string }) => `復帰できません (${p.reason})`,
  attachRejected: (p: {
    uploadId: string;
    reason: string;
    detail: string | null;
  }) =>
    `添付却下: ${p.uploadId} (${p.reason}${p.detail !== null ? ` — ${p.detail}` : ""})`,
  instructionRejected: (p: { reason: string; detail: string | null }) =>
    `指示却下: ${p.reason}${p.detail !== null ? ` — ${p.detail}` : ""}`,
  sessionResetFailed: (p: {
    mode: string;
    reason: string;
    hint: string | null;
  }) =>
    `session_reset 失敗 (${p.mode}): ${p.reason}${p.hint !== null ? ` — ${p.hint}` : ""}`,
  restoreAllConfirm: (p: { count: number }) =>
    `${p.count} 体のオフラインエージェントを一括復元します。よろしいですか?`,
  deleteAllConfirm: (p: { count: number }) =>
    `${p.count} 体のオフラインエージェントを完全に削除します。` +
    "\n会話の復元情報も削除されます。この操作は取り消せません。よろしいですか?",
  deleteAllFailed: (p: { failed: number }) =>
    `${p.failed} 体を削除できませんでした`,
  loginTokenInvalid: "トークンが無効です。",
  loginServerUnreachable: "サーバに接続できませんでした。",
  logoutConfirm: "ログアウトしますか?",
  authErrorProvider: "認証プロバイダでのログインに失敗しました。",
  authErrorNotAllowed:
    "このアカウントはアクセスを許可されていません。管理者に確認してください。",
  authErrorInvalidState:
    "認証セッションの有効期限が切れました。もう一度お試しください。",
  authErrorDefault: "ログインに失敗しました。もう一度お試しください。",
  loginEnterToken: "アクセストークンを入力してください。",
  loginChooseMethod: "ログイン方法を選択してください。",
  loginNoMethod:
    "認証手段が構成されていません。管理者に問い合わせてください。",
  loginForDevice: "device の login を承認するには、先に login してください。",
  tokenPlaceholder: "トークン",
  tokenAria: "アクセストークン",
  loginChecking: "確認中…",
  loginSubmit: "ログイン",
  loginOr: "または",
  loginWithProvider: (p: { provider: string }) => `${p.provider} でログイン`,
  buildInfoAria: "ビルド情報",
  agentListAria: "エージェント一覧",
  settings: "設定",
  launch: "+ 起動",
  logout: "ログアウト",
  snapshotAgentsCapped:
    "一部のエージェントは snapshot の上限により表示されていません。",
  snapshotDeliveryCapped:
    "一部の inter-agent 配送確認は snapshot の上限により表示されていません。",
  snapshotBuildInfoPartial: "ビルド情報の一部を表示できません。",
  snapshotHistoryPartial: "履歴の一部を表示できません。",
  snapshotHostsPartial: "ホスト一覧の一部を表示できません。",
  snapshotDirectoryPartial: "エージェント一覧の一部を表示できません。",
  previousAgentAria: (p: { name: string }) => `前のエージェント ${p.name} へ`,
  previousAgentTitle: (p: { name: string }) => `前: ${p.name}`,
  nextAgentAria: (p: { name: string }) => `次のエージェント ${p.name} へ`,
  nextAgentTitle: (p: { name: string }) => `次: ${p.name}`,
  offlineSummary: (p: { count: number }) => `オフライン(${p.count})`,
  restoreAllTitle: "オフライン全体を一括復元",
  restoreAll: "前回の状態を復元",
  deleteAllTitle: "オフライン全体を台帳ごと削除",
  deleteAll: "すべて削除",
  deletingAll: "削除中…",
  connecting: "接続中…",
};
