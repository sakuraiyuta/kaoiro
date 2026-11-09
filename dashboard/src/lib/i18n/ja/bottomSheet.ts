export const bottomSheet = {
  pending: "対応待ちがあります",
  backToList: "一覧へ戻って対応する",
  othersNeedAttention: (p: { count: number }) => `他に ${p.count} 体が要対応`,
};
