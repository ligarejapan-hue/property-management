import type { z } from "zod";

/**
 * 前回の発行の入力(写しの options)を、次の発行の初めの値にする(設計 第2段階 §3.2)。
 * 今の形(書類の options)で検査して通ったときだけ使う。古い版・壊れた写しは捨てて初めの値のまま。
 */
export function rememberedValues(
  schema: z.ZodType<Record<string, unknown>>, defaults: Record<string, unknown>, snapshot: unknown,
): Record<string, unknown> {
  if (!snapshot || typeof snapshot !== "object" || !("options" in snapshot)) return defaults;
  const r = schema.safeParse((snapshot as { options: unknown }).options);
  return r.success ? r.data : defaults;
}

/** 書類の種類ごとに、いちばん新しい版の写し(rows は版の新しい順に並んでいること)。 */
export function latestSnapshots(rows: { docType: string; inputSnapshot: unknown }[]): Map<string, unknown> {
  const m = new Map<string, unknown>();
  for (const r of rows) if (!m.has(r.docType)) m.set(r.docType, r.inputSnapshot);
  return m;
}
