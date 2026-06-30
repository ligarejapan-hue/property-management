import type { SaleDmDraft } from "@/lib/api-client";

export const DESIGN_OPTIONS = [
  { value: "formal", label: "信頼" },
  { value: "soft", label: "やわらか" },
  { value: "impact", label: "インパクト" },
] as const;

export const TONE_OPTIONS = [
  { value: "formal", label: "フォーマル" },
  { value: "standard", label: "標準" },
  { value: "soft", label: "やわらか" },
] as const;

export const LENGTH_OPTIONS = [
  { value: "short", label: "短い" },
  { value: "medium", label: "中" },
  { value: "long", label: "長い" },
] as const;

export const APPEAL_OPTIONS = [
  { value: "price", label: "好条件での売却" },
  { value: "inheritance", label: "相続・税" },
  { value: "vacant", label: "空き家・管理負担" },
  { value: "buyer", label: "購入希望者あり" },
] as const;

export const STRENGTH_OPTIONS = [
  { value: "low", label: "控えめ" },
  { value: "medium", label: "標準" },
  { value: "high", label: "積極的" },
] as const;

export type AdjustTab = "campaign" | "draft";

export function resolveAdjustTarget(
  tab: AdjustTab,
  selected: Pick<SaleDmDraft, "id"> | null,
): { scope: "campaign" | "draft"; draftId: string | null } {
  if (tab === "draft") return { scope: "draft", draftId: selected?.id ?? null };
  return { scope: "campaign", draftId: null };
}

export interface DraftPatchInput {
  body?: string;
  variantId?: string;
}

export function buildDraftPatch(input: DraftPatchInput): DraftPatchInput {
  const patch: DraftPatchInput = {};
  if (input.body !== undefined) patch.body = input.body;
  if (input.variantId !== undefined) patch.variantId = input.variantId;
  return patch;
}
