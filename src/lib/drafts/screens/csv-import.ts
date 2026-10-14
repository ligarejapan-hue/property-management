/**
 * 取り込み(CSV)画面の控え(設計書 §2 S4)。1つの画面に3つの流れがある:
 *   main = CSV/Excel → 物件(段階 2・3 だけ控える。取り込み後の段階 4 は控えない)
 *   ro   = 受付帳 × 所有者(結果が出たら控えない)
 *   rp   = 受付帳 → 物件(結果が出たら控えない)
 * ファイルの中身は文字(csvText)か base64 で持っているので、選び直しは要らない。
 * 大きいときは土台が "too_large" で止める(§5.4)。
 */
import { z } from "zod/v4";
import type { StoredDraft } from "../draft-store";

type FileEntry = { name: string; csvText?: string; xlsxBase64?: string };
type DlFilter = "marked" | "unmarked" | "all";
type ShinkiFilter = "existing" | "new" | "all";

export interface CsvMainDraft {
  step: 2 | 3;
  fileName: string;
  csvText: string;
  xlsxBase64: string | null;
  template: string;
  headers: string[];
  rows: string[][];
  columnMapping: Record<string, string>;
  /** 重複の下見(サーバーの応答)。形は画面の state と同じ。 */
  duplicatePreview: Record<string, unknown> | null;
}
export interface CsvRoDraft {
  receptionFile: FileEntry | null;
  ownerFile: FileEntry | null;
  dlFilter: DlFilter;
  shinkiFilter: ShinkiFilter;
  roPreview: Record<string, unknown> | null;
}
export interface CsvRpDraft {
  rpFile: FileEntry | null;
  rpDlFilter: DlFilter;
  rpShinkiFilter: ShinkiFilter;
  rpPreview: Record<string, unknown> | null;
}
export interface CsvImportDraft {
  rev: 1;
  main: CsvMainDraft | null;
  ro: CsvRoDraft | null;
  rp: CsvRpDraft | null;
}

const fileSchema = z.object({ name: z.string(), csvText: z.string().optional(), xlsxBase64: z.string().optional() });
const dl = z.enum(["marked", "unmarked", "all"]);
const shinki = z.enum(["existing", "new", "all"]);

const schema = z.object({
  rev: z.literal(1),
  main: z
    .object({
      step: z.union([z.literal(2), z.literal(3)]),
      fileName: z.string(),
      csvText: z.string(),
      xlsxBase64: z.string().nullable(),
      template: z.string(),
      headers: z.array(z.string()),
      rows: z.array(z.array(z.string())),
      columnMapping: z.record(z.string(), z.string()),
      duplicatePreview: z.looseObject({}).nullable(),
    })
    .nullable(),
  ro: z
    .object({
      receptionFile: fileSchema.nullable(),
      ownerFile: fileSchema.nullable(),
      dlFilter: dl,
      shinkiFilter: shinki,
      roPreview: z.looseObject({}).nullable(),
    })
    .nullable(),
  rp: z
    .object({
      rpFile: fileSchema.nullable(),
      rpDlFilter: dl,
      rpShinkiFilter: shinki,
      rpPreview: z.looseObject({}).nullable(),
    })
    .nullable(),
});

export function parseCsvImportDraft(d: unknown): CsvImportDraft | null {
  const r = schema.safeParse(d);
  return r.success ? (r.data as CsvImportDraft) : null;
}

export function isCsvImportDraftEmpty(d: CsvImportDraft): boolean {
  return d.main === null && d.ro === null && d.rp === null;
}

/** 大きすぎて控えを止めた後に、送信中の印だけを残す中身(空)。 */
export function compactCsvImportDraftForPending(): CsvImportDraft {
  return { rev: 1, main: null, ro: null, rp: null };
}

/**
 * 戻し方を決める。送信中の印が残っていたら、取り込みはサーバーで続いているかもしれない
 * =中身は戻さず「取り込み履歴で確かめて」だけ出す(§5.1 S4)。
 */
export function decideCsvImportRestore(
  restored: StoredDraft<CsvImportDraft> | null,
): { start: CsvImportDraft | null; showPending: boolean } {
  if (!restored) return { start: null, showPending: false };
  if (restored.pendingSubmit) return { start: null, showPending: true };
  return { start: restored.data, showPending: false };
}

/**
 * 取り込みが済んだ流れを外した控え(印を外す前に書く)。
 * ⚠画面を離れた後に返事が来ても書き手は生きているので、印を外すだけだと取り込む前の形
 *   (段階3の中身など)が「送信中でない控え」として残り、戻ったときもう一度送れてしまう(§5.1 S4)。
 */
export function csvDraftAfterImport(d: CsvImportDraft, flow: "main" | "ro" | "rp"): CsvImportDraft {
  return { ...d, [flow]: null };
}
