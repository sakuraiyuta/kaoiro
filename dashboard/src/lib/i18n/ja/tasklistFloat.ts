export const tasklistFloat = {
  // Keyed by the tasklist item status.
  status: {
    pending: "未着手",
    in_progress: "進行中",
    completed: "完了",
  },
  listAria: "現在の todo リスト",
  collapse: "折りたたむ",
  expand: "詳細",
  detailAria: "todo の詳細",
  omitted: (p: { count: number; completed: number }) =>
    `以下 ${p.count} 件省略 (うち完了 ${p.completed} 件)`,
};
