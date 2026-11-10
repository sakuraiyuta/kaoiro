export const launchDialog = {
  runnerNoRevision:
    "この host は build revision 情報を報告していません(古い runner)。",
  runnerRevisionUnknown:
    "この host の build revision が unknown です(git 情報なしでビルドされたか、pnpm build を経ていません)。",
  serverRevisionUnavailable:
    "server の build revision を取得できません(古い server、または /api/health の取得に失敗)。",
  serverRevisionUnknown: "server 自身の build revision が unknown です。",
  revisionMismatch: (p: { runner: string; server: string }) =>
    `この host の build revision (${p.runner}…) が server (${p.server}…) と一致しません。`,
  dirtyBoth: (p: { runner: string }) =>
    `この host の build (${p.runner}…) は runner・server の両方でコミットされていない変更を含んでいます(dirty)。`,
  dirtyRunner: (p: { runner: string }) =>
    `この host の build (${p.runner}…) は runner 側でコミットされていない変更を含んでいます(dirty)。`,
  dirtyServer: (p: { runner: string }) =>
    `この host の build (${p.runner}…) は server 側でコミットされていない変更を含んでいます(dirty)。`,
  launchFailed: "起動に失敗しました。",
  dialogTitle: "エージェント起動",
  heading: "エージェントを起動",
  tabNew: "新規",
  tabResume: "再開",
  noHosts: "起動可能なホストがありません(runner 未接続)。",
  deliveryLabel: "実行中の割込配送",
  hintApiUnconfirmed: "この server の操作 API は未確認",
  hintMethodUnconfirmed: "起動時の配送方法は未確認",
  hintHostDefaultUnknown: "host の既定設定は未確認",
  hintHostCeilingOff: "host の上限設定で無効",
  hintEngineUnsupported: "この engine では未対応。メッセージは queue に入る",
  hintManual: "手動で選択した設定を使用",
  hintFallbackOn: "host の既定値がないため on を使用",
  hintHostDefault: "host の既定設定を使用",
  deliveryDescription:
    "あなたやエージェントからの入力は対応する方法で配送し、それ以外は通常の待ち行列に入ります。",
  host: "ホスト",
  packDiagnosticsUnknown: "pack の診断情報は未対応または未確認です。",
  ingestWarnings: (p: { warnings: string }) =>
    `${p.warnings}。設定を修正し server を再起動後、画面を再読込してください。`,
  persona: "ペルソナ",
  cwd: "作業ディレクトリ",
  engine: "エンジン",
  room: "部屋",
  model: "モデル",
  defaultOption: "既定",
  resolvedModelBefore: "取得時点の解決先:",
  resolvedModelAfter: "(起動時に変わる場合があります)",
  refreshCatalog: "モデル一覧を再取得",
  refreshCatalogTitle:
    "モデル一覧を再取得 (runner のキャッシュを無視して live probe)",
  refreshing: "更新中…",
  permissionMode: "permission mode(作業意図)",
  permissionKeep: "前回値を継続 (server 保存値)",
  permissionModeTitle: (p: { sandbox: string; approval: string }) =>
    `書込: ${p.sandbox} / 承認: ${p.approval}`,
  permissionModeOption: (p: {
    mode: string;
    sandbox: string;
    approval: string;
  }) => `${p.mode} (書込 ${p.sandbox} / 承認 ${p.approval})`,
  sandboxLabel: "sandbox(書き込み範囲)",
  sandboxReadOnly: "read-only — 読み取りのみ",
  sandboxWorkspace: "workspace-write — 作業ディレクトリ内のみ書込可",
  sandboxFull: "danger-full-access — 無制限(危険)",
  networkAccess: "sandbox 内のネットワークアクセスを許可",
  approvalLabel: "承認 (approval)",
  approvalUntrusted: "untrusted — 常に確認",
  approvalOnRequest: "on-request — 必要な時だけ確認",
  approvalLocal: "local — 読取と観察系 git は自動",
  approvalNever: "never — 確認しない",
  approvalNote:
    "sandbox 軸はこのエンジンでは advisory (wrapper が引数を検査する だけで OS 強制ではありません)。 local は read-only coreutils と working tree 内の観察系 git を 保守的に分類します。.git への書込と commit / merge は確認し、既存の repo / global config が指定する helper は operator の信頼範囲です。",
  approvalFixedNever:
    "承認 (approval) は never 固定 — Codex は実行中の承認要求に対応しません。",
  agentName: "エージェント名(任意)",
  agentNamePlaceholder: "未入力ならペルソナ名",
  initialPrompt: "初期プロンプト(任意)",
  initialPromptPlaceholder: "最初の指示(空ならアイドルで待機)",
  session: "セッション",
  noSessions: "この cwd に再開可能なセッションはありません。",
  cancel: "キャンセル",
  launching: "起動中…",
  launch: "起動",
};
