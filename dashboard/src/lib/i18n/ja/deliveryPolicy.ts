export const deliveryPolicy = {
  title: "実行中の割込配送",
  savedPolicy: (p: { policy: string }) => `保存設定: ${p.policy}`,
  saving: "保存中",
  apiUnconfirmed: "この server の操作 API は未確認",
  mechanisms: (p: { operatorEarly: string; interAgentEarly: string }) =>
    `あなたから: ${p.operatorEarly} / エージェント間: ${p.interAgentEarly}`,
  interAgentStop: (p: { value: string }) => `エージェント間の停止: ${p.value}`,
  stopUnsupported: "非対応",
  stopToolBoundary: "ツール境界",
  earlyOnly: "（early のみ）",
  acceptedMayComplete: "すでに受け付けた処理は完了する場合があります。",
  allow: "割込配送を許可する",
  refreshTitle:
    "対応する配送方法での受け付けを許可します。配送の成功を保証する設定ではありません。",
  refresh: "配送状態を再取得",
  waitingConnection: "接続待ち",
  unknownNormal: "状態不明・通常配送",
  off: (p: { pending: boolean }) =>
    `off（新しい割込配送を停止）${p.pending ? "・wrapper 確認待ち" : ""}`,
  unsupportedNormalOnly: "非対応・通常配送のみ",
  switchUnsupported: "実行中の切替は未対応",
  onConfirmed: "on（確認済み）",
  awaitingConfirmation: "確認待ち",
  saveUnconfirmed: "保存結果未確認",
  saveUnconfirmedRefreshFailed: "保存結果未確認・状態を再取得できませんでした",
  refreshFailed: "状態を再取得できませんでした",
  conflictReselectAfterRefresh:
    "別の操作で更新されました。再取得後に選び直してください",
  saveFailed: "設定を保存できませんでした",
  conflictReselect: "別の操作で更新されました。選び直してください",
};
