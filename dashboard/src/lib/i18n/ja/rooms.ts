export const rooms = {
  lobbyDefaultName: "ロビー",
  unknownGroup: "部屋を確認できていません",
  memberCount: (p: { n: number }) => `${p.n} 件`,
  emptyRoom: "この部屋に agent はいません",
  createButton: "部屋を作成",
  renameButton: "改名",
  renameAria: (p: { name: string }) => `部屋 ${p.name} を改名`,
  deleteButton: "削除",
  deleteAria: (p: { name: string }) => `部屋 ${p.name} を削除`,
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
