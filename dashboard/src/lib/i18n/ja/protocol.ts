export const protocol = {
  disconnectOperator: "オペレーターによる停止",
  disconnectRunner: "ランナーによる停止",
  disconnectQuotaExhausted: "利用枠の枯渇による停止",
  disconnectCrash: "エージェントの異常終了",
  disconnectAgentSelf: "エージェント自身による停止",
  disconnectUnplanned: "不慮の接続断",
  // Keyed by the wrapper's error_subtype codes.
  errorSubtype: {
    error_max_turns: "最大ターン数到達",
    error_during_execution: "実行中エラー",
    error_max_budget_usd: "予算上限到達",
    error_max_structured_output_retries: "構造化出力リトライ上限",
    error_rollout_corrupted: "セッション破損 (再開不可)",
  },
  resetRequestedBy: (p: { requester: string }) => `${p.requester} が要求`,
};
