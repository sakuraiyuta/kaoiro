export const sessionLifecycleDialog = {
  title: (p: { label: string }) => `${p.label} のセッション履歴`,
  refresh: "更新",
  refreshNote:
    "reset の開始・完了時に自動で再取得します。記録の順序により最新の行がまだ出ない場合や、ほかの種類の履歴は「更新」で取得できます。",
  loading: "読み込み中",
  incomplete:
    "履歴の一部を表示しています。古い行は応答サイズの上限により省略されています。",
  malformedRow: (p: { kind: string; at: string }) =>
    `読めない行 — kind: ${p.kind} / at: ${p.at}`,
  disconnect: (p: { origin: string; reason: string }) =>
    `切断: ${p.origin} (${p.reason})`,
  requestOrigin: (p: { origin: string }) => `要求元: ${p.origin}`,
  requester: (p: { who: string }) => `要求者: ${p.who}`,
};
