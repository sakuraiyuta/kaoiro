export const taskRing = {
  running: (p: { count: number }) =>
    `サブエージェント/workflow実行中 (${p.count}件)`,
};
