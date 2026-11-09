export const agentCard = {
  rateResetDone: "リセット済み",
  terminateConfirm: (p: { name: string; state: string }) =>
    `「${p.name}」は${p.state}です。終了すると進行中の作業は失われる可能性があります。終了しますか?`,
  deleteConfirm: (p: { name: string }) =>
    `オフラインのエージェント「${p.name}」を完全に削除します。` +
    `保存された persona / session ポインタ / permission_mode も破棄され、` +
    `以後この agent_id は復元できなくなります。よろしいですか?`,
  offline: "オフライン",
  restoreFailed: "復元失敗",
  restoreFailedTitle: (p: { reason: string }) => `復元失敗: ${p.reason}`,
  needsAttention: "要対応",
  openDetail: (p: { name: string }) => `${p.name} の詳細を開く`,
  offlineName: (p: { name: string }) => `${p.name} (オフライン)`,
  contextWindow: "生窓",
  workBudget: "作業予算",
  openStatusHistory: (p: { name: string }) =>
    `${p.name} の状況表示の履歴を開く`,
  terminateTitle: "エージェント(wrapper)を終了する",
  terminateAria: (p: { name: string }) => `${p.name} を終了`,
  terminate: "終了",
  terminating: "終了中…",
  restoreTitle: "セッションを再開してエージェントを復帰させる",
  restoreAria: (p: { name: string }) => `${p.name} を復帰`,
  restore: "復帰",
  restoring: "復帰中…",
  interruptTitle: "現在のターンを中断 (ESC 相当)",
  interruptAria: (p: { name: string }) => `${p.name} のターンを中断`,
  interrupt: "中断",
  interrupting: "中断中…",
  deleteTitle: "オフラインエージェントを台帳ごと削除",
  deleteAria: (p: { name: string }) => `${p.name} を削除`,
  delete: "削除",
  deleting: "削除中…",
};
