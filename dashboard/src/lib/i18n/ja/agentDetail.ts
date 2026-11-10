type Axes = { sandbox: string; network: boolean; approval: string | undefined };

// No space before the second "/": the markup this replaced rendered it so.
const axesWithNetwork = (p: Axes) =>
  `書込 ${p.sandbox} / network ${p.network}${p.approval ? `/ 承認 ${p.approval}` : ""}`;

export const agentDetail = {
  driftUnset: "(未設定)",
  rateOverage: "追加",
  rateResetDone: "リセット済み",
  rateReset: (p: { at: string }) => `リセット ${p.at}`,
  rateNoData: "まだ情報がありません",
  resumeCandidatesFailed: "候補を取得できませんでした。",
  resumeCandidatesFailedWith: (p: { reason: string }) =>
    `候補を取得できませんでした (${p.reason})`,
  effortResetNotice: "新モデルで元の effort が使えないため既定へ戻しました",
  modelsRefreshFailingNotice:
    "セッション中のモデル一覧更新に繰り返し失敗しています。切替 button 隣の ↻ から再取得を試みてください",
  modelsRefreshFailed: (p: { reason: string }) =>
    `モデル一覧の再取得に失敗: ${p.reason}`,
  effortCatalogUnavailableNotice:
    "現在のモデルの effort カタログがないため、切替をローカルで止めました。カタログを更新 (↻) するか、初回 turn の後に切り替えてください",
  effortLevelUnsupportedNotice: (p: { requested: string }) =>
    `現在のモデルのカタログに ${p.requested} がないため、切替をローカルで止めました`,
  persistAliasUnknownNotice: (p: { requested: string }) =>
    `保存されていた ${p.requested} は現在の catalog にないので default で開始しました`,
  sdkFallbackNotice: (p: { requested: string; rolledBackTo: string | undefined }) =>
    `安全機構により ${p.requested} から ${p.rolledBackTo ?? "別の model"} に退避しました。設定 ${p.requested} は保持され再起動で復帰します。今すぐ戻すなら切替から選び直してください`,
  switchFailedNotice: (p: {
    kind: "model" | "effort";
    requested: string;
    reason: string;
    rollbackTarget: string | null;
  }) =>
    `${p.kind === "model" ? "モデル" : "effort"}切替に失敗: ${p.requested} は実効に反映されていません (reason: ${p.reason})。${p.rollbackTarget ? `旧値 ${p.rollbackTarget} に` : "最後に成功した値に"}戻しました`,
  bypassConfirm:
    "bypassPermissions: 全ツール許可を即時バイパスします。続行しますか?",
  permissionStatus: {
    pending: "要求済み (次の turn から適用)",
    applying: "適用中 (次の実行が取得済み)",
    applied: "適用済み",
    failed: "失敗",
    unknown: "未確認",
  },
  // Keyed by the server's SetPermissionErrorReason codes.
  permissionError: {
    forbidden: "権限がありません (operator のみ実行できます)",
    invalid_payload: "送信内容が不正です",
    unknown_agent: "対象の agent が見つかりません",
    agent_unavailable: "agent が接続していません",
    unsupported_permission_switch: "この engine は権限切替に未対応です",
    permission_not_ready: "権限情報の準備待ちです",
    session_reset_pending: "session reset の完了待ちです",
    revision_exhausted: "revision を使い切りました",
    persistence_failed: "サーバ側の保存に失敗しました",
    // Axis-agnostic: the error does not identify the failed axis.
    exceeds_launch_ceiling: "要求値が起動時の上限を超えています",
  },
  codexApprovalConfigRecovery:
    "wrapper は要求した approval (既定は never) を明示しています。観測値が異なる場合は、host の $CODEX_HOME/config.toml（既定 ~/.codex/config.toml）の approvals_reviewer と Codex CLI のバージョンを確認してください。原因を直す前に再適用しても、次の turn で再びブロックされる可能性があります。修正後に同じ権限値を一度だけ再適用して新しい revision を割り当て、キャンセルされた指示を再送してください。",
  gateObservationUnavailable: (p: { revision: number; canReselect: boolean }) =>
    `rev ${p.revision} の結果を確認できませんでした。${p.canReselect ? "権限を選び直すと再開します。" : ""}`,
  gateNextOverCeiling: (p: { revision: number; canReselect: boolean }) =>
    `サーバの選択 (rev ${p.revision}) は、再起動後の起動設定の上限を超えています。${p.canReselect ? "上限内の権限を選ぶと再開します。" : ""}同じ組み合わせは、サーバの clamp と wrapper の最終 gate の両方で拒否されるため、選べません。`,
  gateBlocked: (p: { revision: number; step: string; canReselect: boolean }) =>
    `wrapper は rev ${p.revision}${p.step} を適用する前に止まっています。サーバの fallback では何も実行されていません。${p.canReselect ? "権限を選び直すと再開します（同じ組み合わせでも可）。" : ""}キャンセルされた指示は再送されません。`,
  resetWithAttachments: "session の操作コマンドは添付付きでは使えません",
  resetUnavailable: (p: { command: string }) =>
    `このセッションでは ${p.command} は使えません`,
  attachmentsUnsupported: "このセッションでは添付は未対応です",
  attachmentsImagesOnly: "このセッションでは画像のみ添付できます",
  attachmentTypeUnsupported: "このセッションではこの種類の添付は未対応です",
  attachmentLimit: (p: { max: number; dropped: number }) =>
    `添付は ${p.max} 件まで(${p.dropped} 件は無視されました)`,
  deleteConfirm: (p: { name: string }) =>
    `オフラインのエージェント「${p.name}」を完全に削除します。` +
    `保存された persona / session ポインタ / permission_mode も破棄され、` +
    `以後この agent_id は復元できなくなります。よろしいですか?`,
  terminateConfirm: (p: { name: string; state: string }) =>
    `「${p.name}」は${p.state}です。終了すると進行中の作業は失われる可能性があります。終了しますか?`,
  resumeConfirm: (p: { name: string; state: string }) =>
    `「${p.name}」は${p.state}です。セッションを切り替えると進行中の作業は失われる可能性があります。続行しますか?`,
  clearHistoryConfirm:
    "現在のセッション以外の返答ログを消去します。元に戻せません。よろしいですか?",
  backToGrid: "グリッドへ戻る",
  attentionTitle: "一覧へ戻って対応する",
  attentionOthers: (p: { count: number }) =>
    `他に ${p.count} 体が要対応(クリックで一覧へ)`,
  statusSheetLabel: "ステータス",
  pinnedLabel: "ゲージと状況表示",
  pinnedDisclosure: "ゲージと状況",
  pinnedShowAll: "全文を表示",
  pinnedShowLess: "折りたたむ",
  detailTabsLabel: "詳細の表示",
  detailTabEngine: "engine",
  detailTabKaoiro: "kaoiro",
  personaDetailAria: (p: { name: string }) => `${p.name} のペルソナ詳細を表示`,
  renameTitle: "表示名を変更",
  renameAria: (p: { name: string }) => `${p.name} の表示名を変更`,
  renameInputAria: (p: { name: string }) => `${p.name} の新しい表示名`,
  renaming: "変更中…",
  rename: "変更",
  sessionHistory: "セッション履歴",
  accountDefault: "アカウント既定",
  modelPending: "確認待ち",
  modelSwitchTitle: "モデルを切替",
  switchButton: "切替",
  modelsRefreshAria: "モデル一覧を再取得",
  modelsRefreshFailingTitle: "モデル一覧の取得に失敗中。クリックで再取得",
  modelsRefreshTitle: "モデル一覧を再取得",
  modelMenuAria: "モデル候補",
  fallbackModelHint: "安全機構による退避 (設定は保持、再起動で復帰)",
  effortDefault: "既定",
  effortSwitchTitle: "effort を切替",
  effortMenuAria: "effort 候補",
  effortCatalogHint:
    "カタログを更新 (↻) するか、初回 turn の後に effort を切り替えてください",
  resumeDriftTitle: "resume 前後で resolved 設定が変わりました",
  workIntent: "作業意図",
  unconfirmed: "未確認",
  axisWrite: (p: { sandbox: string }) => `書込: ${p.sandbox}`,
  axisApproval: (p: { approval: string }) => `承認: ${p.approval}`,
  permModeMenuAria: "permission mode 候補",
  effectiveWriteScope: "実効書込範囲",
  advisoryTitle:
    "wrapper が tool 引数を検査するのみで OS 強制ではありません (ADR-0057 F4)",
  hostFixedTitle: "ホスト設定により固定",
  pastObservation: "過去の観測",
  pastObservationNote: (p: { revision: number }) =>
    `rev ${p.revision} — 現在の許可ではありません:`,
  sandboxChange: "sandbox 変更",
  ceilingNextTurn: (p: { ceiling: string }) =>
    `上限 ${p.ceiling}・次の turn から適用`,
  nextTurn: "次の turn から適用",
  sandboxMenuAria: "sandbox 候補",
  overCeiling: "上限超",
  networkChange: "network 変更",
  networkDisable: "無効にする",
  networkEnable: "有効にする",
  networkCeiling: (p: { enabled: boolean }) =>
    `上限 ${p.enabled ? "有効" : "無効"}`,
  approvalChange: "承認 変更",
  approvalMenuAria: "承認 候補",
  permissionRequest: "権限要求",
  permissionRequested: (p: Axes) => `要求: ${axesWithNetwork(p)}`,
  permissionRequestedUnknown: "要求: 不明（サーバの選択は未確定）",
  permissionReason: (p: { reason: string }) => `理由: ${p.reason}`,
  reapplyHint:
    "同じ権限値を再適用すると新しい revision になります。適用後、キャンセルされた指示を再送してください。",
  rolledBackApplied: (p: Axes) => `適用前に戻した設定: ${axesWithNetwork(p)}`,
  rolledBackFallback: (p: Axes) =>
    `サーバの fallback（未適用）: ${axesWithNetwork(p)}`,
  permissionRequestError: "権限要求エラー",
  ctxLoading: "取得中",
  ctxWindow: (p: { pct: number }) => `生窓 ${p.pct}%`,
  ctxBudget: (p: { pct: number }) => `作業予算 ${p.pct}%`,
  ctxUnsupported: "未対応",
  iaDelivery: "IA 配送",
  notDispatched: "未 dispatch",
  deliveryLost: (p: { count: number }) => `喪失 ${p.count}`,
  deliveryUncertain: (p: { count: number }) => `未確定 ${p.count}`,
  clearHistoryTitle: "現在のセッション以外の返答ログを消去します",
  clearHistoryDisabledTitle: "現在のセッションが不明なため消去できません",
  clearHistory: "過去セッションのログを消去",
  resumeSwapTitle: "このエージェントを別のセッションから再開する",
  resumeSwapping: "切替中…",
  resumeSwap: "別のセッションから再開…",
  resumeMenuAria: "セッション候補",
  resumeNoCandidates: "この cwd に再開可能なセッションはありません。",
  terminateTitle: "エージェント(wrapper)を終了する",
  terminating: "終了中…",
  terminate: "エージェントを終了",
  restoreTitle: "セッションを再開してエージェントを復帰させる",
  restoring: "復帰中…",
  restore: "エージェントを復帰",
  logEmpty: "まだ返答はありません。",
  showEarlier: (p: { count: number }) => `以前のログを表示 (${p.count} 件)`,
  sessionBoundaryClear: "セッションを消去して新規開始",
  sessionBoundaryNew: "新セッション開始",
  openPeerDetailTitle: (p: { peer: string }) => `${p.peer} の詳細を開く`,
  toolCall: (p: { name: string }) => `ツール呼び出し: ${p.name}`,
  toolResultLinkTitle: "対応する結果へ",
  toolInputTruncated: "\n…(入力が大きいため省略)",
  toolResult: (p: { name: string }) => `結果: ${p.name}`,
  toolCallLinkTitle: "対応する呼び出しへ",
  toolOutputTruncated: "\n…(省略)",
  turnEndError: (p: { detail: string }) => `エラーで終了 (${p.detail})`,
  turnEndErrorPlain: "エラーで終了",
  turnEndDone: "応答完了",
  costTitle:
    "API 標準単価での推定値。Claude サブスク利用時は実課金額ではありません(従量 API キー利用時のみ実コストに近い)。セッション開始からの累計。",
  costTotal: (p: { amount: string }) => `累計 ~$${p.amount}`,
  retryTitle:
    "このプロンプトを新規 instruction として再送します (テキストのみ。元の添付ファイルは含まれません)",
  retrying: "再送中…",
  retry: "再送",
  errorDetail: "詳細",
  interruptTitle: "現在のターンを中断 (ESC 相当)",
  interrupting: "中断中…",
  interrupt: "中断",
  deleteTitle: "オフラインエージェントを台帳ごと削除",
  deleting: "削除中…",
  delete: "削除",
  permissionExpandTitle: "許可ダイアログを展開",
  permissionWaiting: "許可待ち(クリックで展開)",
  minimizeTitle: "最小化",
  permissionMinimizeAria: "許可ダイアログを最小化",
  // The tool name sits between the two parts, in a <code> element.
  permissionAskBefore: "",
  permissionAskAfter: " の実行許可を求めています",
  codexDenyNote: (p: { minutes: number | null }) =>
    `拒否の理由は Codex に届きません (decline のみ送信)。${p.minutes !== null ? `応答がないまま ${p.minutes} 分 無活動が続くと、turn の watchdog がこの要求ごと turn を中断します。` : ""}`,
  permissionInputTruncated: "(input は大きすぎるため省略)",
  allow: "許可",
  deny: "拒否",
  codexRecoveryExpandTitle: "Codex 権限復旧プロンプトを展開",
  codexRecoveryWaiting: "権限復旧待ち(クリックで展開)",
  codexRecoveryMinimizeAria: "Codex 権限復旧プロンプトを最小化",
  codexGateStopped: "Codex の権限確認が止まっています",
  codexGateReapplyHint:
    "同じ sandbox / network を再適用して新しい revision を作ると、次の turn で復旧できます。キャンセルされた指示は再送してください。",
  reapplySame: "同じ権限値を再適用",
  gateStopped: "権限の確認で止まっています",
  questionExpandTitle: "質問ダイアログを展開",
  questionWaiting: "回答待ち(クリックで展開)",
  questionMinimizeAria: "質問ダイアログを最小化",
  questionTitle: "回答を選んでください",
  questionOtherPlaceholder: "自由記述",
  answer: "回答",
  cancel: "キャンセル",
  dialogModeHint:
    "現在の作業意図では質問に応答できません (session_capabilities.user_input_modes)",
  composerAria: "指示入力 + 添付",
  slashMenuAria: "スラッシュコマンド候補",
  resetProgress: (p: { mode: string; requester: string | null }) =>
    `新しいsessionを開始中…(mode: ${p.mode}${p.requester ? ` / ${p.requester}` : ""})`,
  composerResetPlaceholder: "session reset 中は入力できません",
  composerPlaceholder:
    "指示を送る…(Ctrl+Enter で送信、/ でコマンド候補、ドラッグドロップ・ペーストで画像等ファイル送信)",
  attachImagesTitle: "画像を添付(複数可)",
  attachFilesTitle:
    "ファイル添付(画像 / テキスト / コード / PDF / Office、複数可)",
  attachUnsupportedTitle: "このセッションでは未対応",
  sending: "送信中…",
  send: "送信",
  trayCount: (p: { count: number; max: number }) => `添付 ${p.count}/${p.max}`,
  removeAttachmentAria: "添付を解除",
  uploadProgressAria: "アップロード進捗",
  sendingNote: "送信中… 応答待ち",
};
