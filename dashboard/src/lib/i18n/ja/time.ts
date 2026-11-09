export const time = {
  justNow: "たった今",
  secondsAgo: (p: { n: number }) => `${p.n} 秒前`,
  minutesAgo: (p: { n: number }) => `${p.n} 分前`,
  hoursAgo: (p: { n: number }) => `${p.n} 時間前`,
  daysAgo: (p: { n: number }) => `${p.n} 日前`,
};
