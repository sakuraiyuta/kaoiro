export const statusLineHistoryDialog = {
  emptyFirstLine: "(空の先頭行)",
  agentGone: "このエージェントの履歴は現在表示できません",
  temporarilyUnavailable: "履歴を一時的に取得できません",
  ariaLabel: (p: { label: string }) => `${p.label} の状況表示の履歴`,
  title: (p: { label: string }) => `${p.label} の状況表示`,
  cleared: "(クリア)",
  collapse: "折りたたむ",
  expand: "展開",
};
