/**
 * 物件の編集の小窓の控え(設計書 §2 S5・§4.3)。変えた欄だけ+基にした版番号を持つ。
 * ⚠版が違えば重ねない(ほかの人の保存を古い入力で上書きしない)。
 */
import { z } from "zod/v4";
import type { BuildingChoice } from "@/lib/building-link/resolve";
import { buildingChoiceSchema } from "./building-choice";

export interface PropertyEditDraft {
  propertyId: string;
  baseVersion: number;
  changed: Record<string, string>;
  buildingChoice: BuildingChoice;
}

const schema = z.object({
  propertyId: z.string().min(1),
  baseVersion: z.number().int(),
  changed: z.record(z.string(), z.string()),
  buildingChoice: buildingChoiceSchema,
});

export function parsePropertyEditDraft(d: unknown): PropertyEditDraft | null {
  const r = schema.safeParse(d);
  return r.success ? r.data : null;
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
    const raw = property[key];
    if (v !== (raw != null ? String(raw) : "")) out[key] = v;
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
