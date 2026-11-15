/**
 * 物件の編集の小窓の控え(設計書 §2 S5・§4.3)。変えた欄だけ+基にした版番号を持つ。
 *
 * ⚠版が違っても控えは捨てない(2026-11-15 発注者決定=案1)。**変えた欄だけ**を最新の内容に重ね、
 *   「ほかで更新がありました。入力は残しています」と知らせる(rebased)。
 *   前は版が違うと控えを捨てていた。物件を作った直後の調査情報の自動取得(空欄を埋めて版を進める)でも
 *   版が変わるので、人が何もしていないのに入力が消えていた(実機確認 2026-11-15)。
 *   重ねるのは人が変えた欄だけ=ほかの欄は最新の値のまま。同じ欄をほかの人も変えていた場合は、
 *   知らせを見て人が確かめてから保存する。
 */
import { z } from "zod/v4";
import type { BuildingChoice } from "@/lib/building-link/resolve";
import { buildingChoiceSchema } from "./building-choice";
import { manToYen } from "@/lib/yen-man";
import { extraParcelsEditValue } from "@/lib/property-parcels";

/**
 * 画面では円で入れる欄(保存は万円・2026-11-03 発注者「万円表示にしない」)。
 * 開いた時点の値も円に直してから比べる(直さないと開いただけで「変えた」扱いになる)。
 */
export const YEN_EDIT_KEYS: ReadonlySet<string> = new Set(["salePrice", "saleTaxAmount"]);

/** 物件の値を編集画面の欄の文字に。円の欄は万円→円。 */
export function editFieldValue(key: string, raw: unknown): string {
  if (YEN_EDIT_KEYS.has(key)) return manToYen(raw);
  // ほかの土地・建物は行の JSON(足していなければ空)。
  if (key === "extraParcels") return extraParcelsEditValue(raw);
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
): { values: Record<string, string>; applied: boolean; rebased: boolean } {
  if (!draft || draft.propertyId !== propertyId) {
    return { values: initial, applied: false, rebased: false };
  }
  // 版が違う=控えを取ったあとに物件が更新された。変えた欄だけを最新の内容に重ねる(rebased=知らせを出す)。
  return { values: { ...initial, ...draft.changed }, applied: true, rebased: draft.baseVersion !== version };
}

/** 控えが、いま開いている版より前の版に対する入力か(=重ねたうえで知らせる)。 */
export function isRebasedDraft(draft: PropertyEditDraft | null, propertyId: string, version: number): boolean {
  return draft != null && draft.propertyId === propertyId && draft.baseVersion !== version;
}

export function decideEditDraftOnLoad(
  draft: PropertyEditDraft | null,
  propertyId: string,
  version: number,
): "none" | "reopen" | "stale" {
  if (!draft || draft.propertyId !== propertyId) return "none";
  // どちらも小窓を開き直す。"stale" は、開いた小窓が「ほかで更新がありました」と知らせる(控えは捨てない)。
  return draft.baseVersion === version ? "reopen" : "stale";
}
