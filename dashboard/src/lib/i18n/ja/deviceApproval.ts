export const deviceApproval = {
  unknownCode:
    "この code は見つかりません。device に表示された code と入力を確かめてください。",
  expired:
    "この code は期限が切れています。device で login をやり直し、新しい code を取得してください。",
  rateLimited: (p: { seconds: number }) =>
    `試行が多すぎます。${p.seconds} 秒ほど待ってから、もう一度入力してください。`,
  alreadyDecided: "この code はすでに承認または拒否されています。",
  unauthorized: "session が切れました。OAuth で login し直してください。",
  oauthSessionRequired:
    "共有 token の session では承認できません。OAuth で login し直してください。",
  unavailable: "この server は device 承認を提供していません。",
  generic: "処理に失敗しました。入力をやり直してください。",
  title: "device の login の承認",
  enterCode: "device に表示された code を入力",
  checking: "確認中…",
  check: "確認",
  selfReported: "(client の自己申告。信頼の根拠ではない)",
  issued: "発行",
  remaining: "残り",
  identityToApprove: "承認する identity",
  connectsAs: "この identity と role で device が接続する。",
  verifyWarning:
    "device に表示された code と一致することを確かめる。自分が今始めた login でなければ拒否する。",
  approve: "承認",
  deny: "拒否",
  approved: "承認した。device 側は数秒で接続する。",
  denied: "拒否した。device 側には拒否が伝わる。",
  loginWith: (p: { provider: string }) => `${p.provider} でログイン`,
  enterAgain: "入力し直す",
  remainingSeconds: (p: { seconds: number }) => `${p.seconds} 秒`,
  remainingMinutes: (p: { minutes: number; seconds: number }) =>
    `${p.minutes} 分 ${p.seconds} 秒`,
};
