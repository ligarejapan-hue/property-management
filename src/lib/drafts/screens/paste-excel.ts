/** Excelからまとめて物件化の控え(設計書 §2 S2・§5.2)。 */
import { z } from "zod/v4";
import type { ExcelLeadResult, ExcelLeadRow } from "@/components/import/excel-lead-table";

/**
 * sendingKey = いま送っている行(結果が来る前に画面を離れたら、戻ったとき「分からない」にする)。
 * ファイル本体は持たない(読み取った後は不要)。
 */
export interface PasteExcelDraft {
  rev: 1;
  fileName: string | null;
  rows: ExcelLeadRow[];
  results: Record<string, ExcelLeadResult>;
  sendingKey: string | null;
}

const rowSchema = z.looseObject({
  sheetName: z.string(),
  rowNumber: z.number(),
  text: z.string(),
  draft: z.looseObject({}),
  ownerNote: z.string(),
  status: z.enum(["ready", "review", "registered"]),
  reasons: z.array(z.string()),
  registeredPropertyId: z.string().nullable(),
});

const resultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("created"), propertyId: z.string() }),
  z.object({ kind: z.literal("duplicate") }),
  z.object({ kind: z.literal("review"), reasons: z.array(z.string()) }),
  z.object({ kind: z.literal("failed"), message: z.string() }),
  z.object({ kind: z.literal("unknown") }),
]);

const schema = z.object({
  rev: z.literal(1),
  fileName: z.string().nullable(),
  rows: z.array(rowSchema),
  results: z.record(z.string(), resultSchema),
  sendingKey: z.string().nullable(),
});

export function parsePasteExcelDraft(d: unknown): PasteExcelDraft | null {
  const r = schema.safeParse(d);
  return r.success ? (r.data as unknown as PasteExcelDraft) : null;
}

export function isPasteExcelDraftEmpty(d: PasteExcelDraft): boolean {
  return d.rows.length === 0;
}

/**
 * 戻したときの行ごとの結果。送っている途中だった行に結果が無ければ「分からない」にする
 * (まとめて登録の対象から外れる=二重登録を防ぐ)。結果が届いていればそのまま。
 */
export function restoreExcelResults(
  results: Record<string, ExcelLeadResult>,
  sendingKey: string | null,
): Record<string, ExcelLeadResult> {
  if (sendingKey == null || results[sendingKey] !== undefined) return results;
  return { ...results, [sendingKey]: { kind: "unknown" } };
}
