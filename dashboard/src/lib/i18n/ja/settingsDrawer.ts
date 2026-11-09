export const settingsDrawer = {
  title: "設定",
  sourceFetching: "取得中",
  sourceStored: "設定済み",
  sourceEnv: "環境変数",
  sourceDefault: "既定値",
  bulkListIncomplete: "会話一覧が不完全なため、一括操作を確認できません",
  bulkAgentsMissing: "エージェント一覧を取得できていません",
  conversationsRefreshFailed: "会話一覧を更新できませんでした",
  bulkSummary: (p: {
    closed: number;
    closeSkipped: number;
    accepted: number;
    resetSkipped: number;
    resetUnknown: number;
  }) =>
    `一括操作: 会話を ${p.closed} 件 close (skip ${p.closeSkipped})、セッションを ${p.accepted} 件 reset 受付 (skip ${p.resetSkipped}、結果不明 ${p.resetUnknown})`,
  notificationSound: "通知音",
  volume: "音量",
  statsToggle: "カードに engine・model・effort と ctx・5h・7day を表示",
  hideNonMessage: "エージェント詳細のログでツール呼び出しなどを非表示",
  gridSort: "グリッドの並び順",
  sortName: "名前順",
  sortRecent: "最近動いた順 (状態が変わると並びが動く)",
  sessionHistory: "セッション履歴",
  agentId: "エージェント ID",
  showHistory: "履歴を表示",
  deletedAgentsHint:
    "削除済みのエージェントも、ID を入力して保持されている履歴を確認できます。",
  quagmireTitle: "停滞検知のしきい値",
  quagmireHint: (p: { source: string }) =>
    `エージェント間のやり取りがこの通数に達すると警告バナーを出します (現在の設定元: ${p.source})。`,
  neverDetect: "検知しない (∞)",
  threshold: "しきい値",
  turnsCount: (p: { n: number }) => `${p.n} 通`,
  directInput: (p: { max: number }) => `直接入力 (1〜${p.max})`,
  thresholdError: (p: { reason: string }) =>
    `しきい値を変更できません: ${p.reason}`,
  retentionTitle: "状況表示の履歴件数",
  retentionHint: (p: { source: string }) =>
    `各エージェントの状況表示について、変更履歴を何件まで残すかを決めます。 減らすと、超えた古い履歴はすぐに消えます (現在の設定元: ${p.source})。`,
  retentionLabel: "件数",
  retentionLabelRange: (p: { min: number; max: number }) =>
    `件数 (${p.min}〜${p.max})`,
  retentionError: (p: { reason: string }) => `件数を変更できません: ${p.reason}`,
  bulkTitle: "一括クリーンアップ",
  bulkHint:
    "開いている会話を閉じ、接続中のエージェントのセッションを clear します。",
  bulkChecking: "対象を確認中…",
  bulkButton: "一括 close + session reset",
  bulkPrepareFailed: (p: { reason: string }) =>
    `一括操作を準備できませんでした: ${p.reason}`,
  conversationsTitle: "会話一覧",
  refreshConversationsAria: "会話一覧を更新",
  refresh: "更新",
  showClosed: "閉じた会話も表示",
  hiddenClosed: (p: { n: number }) => `閉じた会話 ${p.n} 件を非表示`,
  fetchFailed: (p: { reason: string }) => `取得に失敗しました(${p.reason})`,
  partialConversations: "一部の会話を表示できません",
  noOpenConversations: "開いている会話はありません",
  closeConversation: "閉じる",
  usersTitle: "ユーザー一覧",
  refreshUsersAria: "ユーザー一覧を更新",
  noUsers: "登録されているユーザーはいません",
  displayNameAria: (p: { id: string }) => `${p.id} の表示名`,
  saving: "保存中…",
  save: "保存",
  cancel: "キャンセル",
  failed: (p: { reason: string }) => `失敗しました(${p.reason})`,
  rename: "名前を変更",
  confirmCloseAria: "会話を閉じる確認",
  confirmClose: "この会話を閉じますか?参加エージェントに通知されます。",
  closing: "閉じています…",
  bulkConfirmAria: "一括クリーンアップ確認",
  bulkConfirm: (p: { conversations: number; agents: number }) =>
    `会話 ${p.conversations} 件を閉じ、エージェント ${p.agents} 体のセッションを clear します。続けますか?`,
  processing: "処理中…",
  execute: "実行",
  logout: "ログアウト",
};
