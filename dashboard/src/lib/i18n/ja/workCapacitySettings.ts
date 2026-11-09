export const workCapacitySettings = {
  nominatedLimit: "指名待ちの上限（依頼者・担当者ごと）",
  activeLimit: "実行中の上限（担当者ごと）",
  sourceDashboard: "ダッシュボード",
  sourceConfig: "サーバー設定",
  sourceDefault: "既定値",
  revisionConflict:
    "別の変更が保存されました。最新の値を確認して、もう一度入力してください。",
  title: "作業の受け入れ上限",
  intro:
    "0 は無制限です。保存した値は再起動後も残ります。上限を下げても既存の作業は取り消されません。",
  docsLink: "設定の説明",
  stateUnknown: "保存状態を確認できません",
  repairLink: "復旧手順",
  unavailable:
    "設定未取得、未接続、またはサーバーがこの設定に対応していません。",
  unlimited: "無制限 (0)",
  effective: (p: { value: string; source: string; fallback: number }) =>
    `適用値: ${p.value} / 設定元: ${p.source} / サーバー設定: ${p.fallback}`,
  resetToServer: (p: { label: string }) => `サーバー設定に戻す: ${p.label}`,
  save: "保存",
  reload: "設定・変更履歴を読み直す",
  newerSettings:
    "サーバーの設定が更新されました。入力は保持しています。適用値を確認してから保存してください。",
  uncertain:
    "結果が不明です。保存を繰り返さず、設定を読み直してください。",
  lastChange: (p: { at: string; actor: string; revision: number }) =>
    `最終変更: ${p.at} / ${p.actor} / revision ${p.revision}`,
  recentChanges: "最近の変更（最大100件）",
};
