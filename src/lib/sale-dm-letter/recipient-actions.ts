import type { SaleDmDraft, SaleDmVariant } from "@/lib/api-client";

export function variantLabel(variants: SaleDmVariant[], variantId: string): string {
  return variants.find((v) => v.id === variantId)?.label ?? "-";
}

export function isInquiry(draft: Pick<SaleDmDraft, "lpFirstAccessAt" | "phoneInquiryAt">): boolean {
  return Boolean(draft.lpFirstAccessAt) || Boolean(draft.phoneInquiryAt);
}

export interface OutcomeInput {
  deliveryStatus?: string;
  phoneInquiry?: boolean;
}

// 未指定キーを落として PATCH ペイロードを作る(部分更新)。
export function buildOutcomePayload(input: OutcomeInput): OutcomeInput {
  const payload: OutcomeInput = {};
  if (input.deliveryStatus !== undefined) payload.deliveryStatus = input.deliveryStatus;
  if (input.phoneInquiry !== undefined) payload.phoneInquiry = input.phoneInquiry;
  return payload;
}
