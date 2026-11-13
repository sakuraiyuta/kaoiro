export const rooms = {
  lobbyDefaultName: "ロビー",
  unknownGroup: "部屋を確認できていません",
  memberCount: (p: { n: number }) => `${p.n} 件`,
  stripToggle: (p: { name: string; open: boolean; count: number; state: string }) =>
    `部屋 ${p.name} を${p.open ? "閉じる" : "開く"}、${p.count} 件、${p.state}`,
  stripStates: {
    idle: "待機中", sending: "送信中", thinking: "思考中", tool_running: "ツール実行中",
    waiting_permission: "許可待ち", waiting_question: "回答待ち", waiting_input: "入力待ち",
    done: "完了", error: "エラー", disconnected: "切断中",
  },
  emptyRoom: "この部屋に agent はいません",
  createButton: "部屋を作成",
  renameButton: "改名",
  renameAria: (p: { name: string }) => `部屋 ${p.name} を改名`,
  deleteButton: "削除",
  deleteAria: (p: { name: string }) => `部屋 ${p.name} を削除`,
  cleanupButton: "この部屋を後片付け",
  cleanupAria: (p: { name: string }) => `部屋 ${p.name} を後片付け`,
  cleanupTitle: (p: { name: string }) => `部屋 ${p.name} の後片付け`,
  cleanupCounts: (p: { conversations: number; agents: number }) => `会話 ${p.conversations} 件を閉じ、接続中の agent ${p.agents} 件の session を消します。`,
  cleanupLimit: "部屋の更新通知が遅れたり届かなかったりした場合、または照合後に所属が変わった場合は、移動後の対象に操作が届くことがあります。",
  cleanupStale: "対象を確認できないか変更されました。後片付けを開き直してください。",
  reorderUp: "↑",
  reorderUpAria: (p: { name: string }) => `部屋 ${p.name} を上へ移動`,
  reorderDown: "↓",
  reorderDownAria: (p: { name: string }) => `部屋 ${p.name} を下へ移動`,
  moveButton: "部屋を移動",
  moveAria: (p: { name: string }) => `${p.name} を別の部屋へ移動`,
  createTitle: "部屋を作成",
  renameTitle: (p: { name: string }) => `部屋 ${p.name} を改名`,
  nameLabel: "部屋の名前",
  namePlaceholder: "例: レビュー",
  working: "処理中…",
  moveTitle: (p: { name: string }) => `${p.name} を別の部屋へ移動`,
  moveCurrentRoom: (p: { room: string }) => `現在の部屋: ${p.room}`,
  moveDestinationLabel: "移動先",
  noDestination: "移動先にできる部屋がありません",
  moveClosing: (p: { n: number }) =>
    p.n === 0
      ? "この移動で閉じる会話はありません。"
      : `この移動で ${p.n} 件の会話が閉じます。`,
  moveConfirm: "移動する",
  deleteTitle: (p: { name: string }) => `部屋 ${p.name} を削除`,
  deleteMembers: (p: { n: number; lobby: string }) =>
    p.n === 0
      ? "この部屋に agent はいません。"
      : `この部屋の ${p.n} 件の agent は ${p.lobby} に戻ります。`,
  deleteClosing: (p: { n: number }) =>
    p.n === 0
      ? "この削除で閉じる会話はありません。"
      : `この削除で ${p.n} 件の会話が閉じます。`,
  deleteConfirm: "削除する",
  previewNote:
    "件数は確認した時点の目安です。実行までに変わることがあります。",
  previewLoading: "閉じる会話の件数を確認しています…",
  previewFailed: (p: { code: string }) =>
    `閉じる会話の件数を確認できません (${p.code})。閉じて開き直してください。`,
  reload: "読み直す",
  movedNotice: (p: { name: string; room: string; closed: number }) =>
    `${p.name} を ${p.room} へ移動しました。閉じた会話は ${p.closed} 件です。`,
  deletedNotice: (p: { room: string; moved: number; closed: number }) =>
    `部屋 ${p.room} を削除しました。agent ${p.moved} 件の所属を戻し、会話 ${p.closed} 件を閉じました。`,
  // Keyed by the server's codes (docs/reference/protocol/channels.md) and the
  // two the client raises itself: timeout and invalid_reply.
  error: {
    forbidden: "権限がありません (operator のみ実行できます)",
    invalid_room_name:
      "部屋の名前が正しくありません (空白のみ、制御文字、長すぎる名前は使えません)",
    missing_room_id: "部屋が指定されていません",
    unknown_room: "その部屋は存在しません",
    rooms_unavailable: "サーバが部屋の情報を保存または読み取れませんでした",
    room_change_unconfirmed:
      "変更が反映されたか確認できません。読み直して確かめてください",
    timeout:
      "サーバから応答がありません。変更が反映されたか確認できません。読み直して確かめてください",
    invalid_reply:
      "サーバの応答を読み取れません。変更が反映されたか確認できません。読み直して確かめてください",
    lobby_protected: "ロビーは削除できません",
    unknown_agent: "その agent は存在しません",
    invalid_agent_id: "agent の指定が正しくありません",
    missing_agent_id: "agent が指定されていません",
  },
  errorUnknown: (p: { code: string }) => `失敗しました (${p.code})`,
};
