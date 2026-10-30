import type { z } from "zod";
import type { FormDef, FormValues } from "./forms/types";
import { fitFormValues } from "./forms/values";

/**
 * 前回の発行の入力(写しの options)を、次の発行の初めの値にする(設計 第2段階 §3.2)。
 * 今の形(書類の options)で検査して通ったときだけ使う。古い版・壊れた写しは捨てて初めの値のまま。
 * 項目の表(form)のある書類は、書式が変わって合わなくなった項目だけ初めの値に戻し、残りは使う(2026-10-30)。
 */
export function rememberedValues(
  schema: z.ZodType<Record<string, unknown>>, defaults: Record<string, unknown>, snapshot: unknown, form?: FormDef,
): Record<string, unknown> {
  if (!snapshot || typeof snapshot !== "object" || !("options" in snapshot)) return defaults;
  const options = (snapshot as { options: unknown }).options;
  const r = schema.safeParse(options);
  if (r.success) return r.data;
  if (!form || !options || typeof options !== "object") return defaults;
  const fitted = schema.safeParse(fitFormValues(form, options, defaults as FormValues).values);
  return fitted.success ? fitted.data : defaults;
}

/**
 * 発行の小窓の初めの値: その書類の、base と同じ出し分け(by の欄の値)の、いちばん新しい入力(2026-10-30)。
 * 両手の取引で、売主様用(売却・売主様あて)と買主様用(購入・買主様あて)の入力が混ざらない。by が無ければいちばん新しい入力。
 */
export function rememberedStart(
  rows: { docType: string; inputSnapshot: unknown }[], docType: string,
  schema: z.ZodType<Record<string, unknown>>, base: Record<string, unknown>, by?: string, form?: FormDef,
): Record<string, unknown> {
  const snapshot = latestMatching(rows, docType, by ? (o) => o[by] === base[by] : undefined);
  return rememberedValues(schema, base, snapshot, form);
}

/**
 * その書類のいちばん新しい発行の写しのうち、match に合うもの(rows は発行の新しい順・match が無ければ最初の1つ)。
 * match には写しの options を渡す(options が無い・壊れている写しは {} として渡す)。
 */
export function latestMatching(
  rows: { docType: string; inputSnapshot: unknown }[], docType: string, match?: (options: Record<string, unknown>) => boolean,
): unknown {
  for (const r of rows) {
    if (r.docType !== docType) continue;
    if (!match) return r.inputSnapshot;
    const s = r.inputSnapshot;
    const o = s && typeof s === "object" && "options" in s && (s as { options: unknown }).options && typeof (s as { options: unknown }).options === "object"
      ? (s as { options: Record<string, unknown> }).options : {};
    if (match(o)) return r.inputSnapshot;
  }
  return undefined;
}

/** 書類の種類ごとに、いちばん新しい版の写し(rows は版の新しい順に並んでいること)。 */
export function latestSnapshots(rows: { docType: string; inputSnapshot: unknown }[]): Map<string, unknown> {
  const m = new Map<string, unknown>();
  for (const r of rows) if (!m.has(r.docType)) m.set(r.docType, r.inputSnapshot);
  return m;
}
