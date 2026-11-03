/**
 * 物件の編集の小窓の控え(設計書 §2 S5・§4.3)。変えた欄だけ+基にした版番号を持つ。
 * ⚠版が違えば重ねない(ほかの人の保存を古い入力で上書きしない)。
 */
import { z } from "zod/v4";
import type { BuildingChoice } from "@/lib/building-link/resolve";
import { buildingChoiceSchema } from "./building-choice";
import { manToYen } from "@/lib/yen-man";

/**
 * 画面では円で入れる欄(保存は万円・2026-11-03 発注者「万円表示にしない」)。
 * 開いた時点の値も円に直してから比べる(直さないと開いただけで「変えた」扱いになる)。
 */
export const YEN_EDIT_KEYS: ReadonlySet<string> = new Set(["salePrice", "saleTaxAmount"]);

/** 物件の値を編集画面の欄の文字に。円の欄は万円→円。 */
export function editFieldValue(key: string, raw: unknown): string {
  if (YEN_EDIT_KEYS.has(key)) return manToYen(raw);
  return raw != null ? String(raw) : "";
}

export interface PropertyEditDraft {
  propertyId: string;
  baseVersion: number;
  changed: Record<string, string>;
  buildingChoice: BuildingChoice;
  /** 円の欄を円で持つ控えか。⚠これが無い控え(円にする前に保存された分)の円の欄は万円なので、読むときに円へ直す。 */
  yen?: true;
}

const schema = z.object({
  propertyId: z.string().min(1),
  baseVersion: z.number().int(),
  changed: z.record(z.string(), z.string()),
  buildingChoice: buildingChoiceSchema,
  yen: z.literal(true).optional(),
});

export function parsePropertyEditDraft(d: unknown): PropertyEditDraft | null {
  const r = schema.safeParse(d);
  if (!r.success) return null;
  if (r.data.yen) return r.data;
  const changed = { ...r.data.changed };
  for (const key of YEN_EDIT_KEYS) {
    if (key in changed && changed[key] !== "") changed[key] = manToYen(changed[key]);
  }
  return { ...r.data, changed, yen: true };
}

export function isPropertyEditDraftEmpty(d: PropertyEditDraft): boolean {
  return Object.keys(d.changed).length === 0 && d.buildingChoice.kind === "auto";
}

/** 開いた時点の値と違う欄だけ(編集の小窓の hasUnsavedInput と同じ比べ方)。 */
export function changedValues(
  values: Record<string, string>,
  property: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(values)) {
    if (v !== editFieldValue(key, property[key])) out[key] = v;
  }
  return out;
}

export function mergeDraftIntoInitial(
  initial: Record<string, string>,
  draft: PropertyEditDraft | null,
  propertyId: string,
  version: number,
): { values: Record<string, string>; applied: boolean } {
  if (!draft || draft.propertyId !== propertyId || draft.baseVersion !== version) {
    return { values: initial, applied: false };
  }
  return { values: { ...initial, ...draft.changed }, applied: true };
}

export function decideEditDraftOnLoad(
  draft: PropertyEditDraft | null,
  propertyId: string,
  version: number,
): "none" | "reopen" | "stale" {
  if (!draft || draft.propertyId !== propertyId) return "none";
  return draft.baseVersion === version ? "reopen" : "stale";
}
