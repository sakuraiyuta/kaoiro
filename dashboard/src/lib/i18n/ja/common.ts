// Wording shared by screens whose role is the same. Text that happens to match
// but has a different role belongs to its own area (docs/contributing/
// dashboard-strings.md).
export const common = {
  close: "閉じる",
  cancel: "キャンセル",
  loading: "読み込み中…",
  noHistory: "履歴はありません",
  historyFetchFailed: (p: { reason: string }) =>
    `履歴を取得できません (${p.reason})`,
};
