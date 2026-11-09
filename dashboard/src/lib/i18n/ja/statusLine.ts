export const statusLine = {
  headOmitted: "(冒頭が長いため省略)",
  moreAvailable: (p: { kb: string }) => `…続きあり (${p.kb} KB)`,
  unset: "未設定",
};
