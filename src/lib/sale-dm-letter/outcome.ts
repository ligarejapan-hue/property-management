// 反響(問い合わせ)の正準定義(設計書):
//   outcome=inquiry ⇔ LP アクセス(lpFirstAccessAt) または 電話(phoneInquiryAt) のいずれかが存在。
// DB の outcome カラムはこの値の永続キャッシュ。書き込み route はこの関数で同期する。
export type DmOutcomeValue = "none" | "inquiry";

export function deriveOutcome(input: {
  lpFirstAccessAt: Date | null;
  phoneInquiryAt: Date | null;
}): DmOutcomeValue {
  return input.lpFirstAccessAt != null || input.phoneInquiryAt != null
    ? "inquiry"
    : "none";
}
