/** 謄本PDFの取り込みの控え(設計書 §2 S3)。結果の段階(取り込み後)は控えない。 */
import { z } from "zod/v4";

export type RegistryDraftStep = "upload" | "extract" | "confirm";

export interface RegistryPdfDraft {
  rev: 1;
  step: RegistryDraftStep;
  uploadTab: "file" | "text";
  text: string;
  fileName: string | null;
  /** ファイルを読んで解析した(取り込みのときもう一度ファイルが要る)。 */
  fromFile: boolean;
  fields: Record<string, { value: string; confidence: "high" | "medium" | "low" }>;
  owners: { name: string; address: string; share: string }[];
  warnings: string[];
  isLikelyScanned: boolean;
  embeddedTextLength: number | null;
  target: "new" | "existing" | "auto";
  existingPropertyId: string;
  propertySearchQuery: string;
  /** 選んであった既存の物件(検索結果は控えないので、選んだ1件だけ持つ)。 */
  existingProperty: { id: string; address: string; lotNumber: string | null; realEstateNumber: string | null } | null;
}

const schema = z.object({
  rev: z.literal(1),
  step: z.enum(["upload", "extract", "confirm"]),
  uploadTab: z.enum(["file", "text"]),
  text: z.string(),
  fileName: z.string().nullable(),
  fromFile: z.boolean(),
  fields: z.record(z.string(), z.object({ value: z.string(), confidence: z.enum(["high", "medium", "low"]) })),
  owners: z.array(z.object({ name: z.string(), address: z.string(), share: z.string() })),
  warnings: z.array(z.string()),
  isLikelyScanned: z.boolean(),
  embeddedTextLength: z.number().nullable(),
  target: z.enum(["new", "existing", "auto"]),
  existingPropertyId: z.string(),
  propertySearchQuery: z.string(),
  existingProperty: z
    .object({ id: z.string(), address: z.string(), lotNumber: z.string().nullable(), realEstateNumber: z.string().nullable() })
    .nullable(),
});

export function parseRegistryPdfDraft(d: unknown): RegistryPdfDraft | null {
  const r = schema.safeParse(d);
  return r.success ? r.data : null;
}

/** 最初の段階で貼った文章も無い=控える意味が無い(ファイル本体は戻せない)。 */
export function isRegistryPdfDraftEmpty(d: RegistryPdfDraft): boolean {
  return d.step === "upload" && d.text.trim() === "";
}

export function compactRegistryPdfDraftForPending(): RegistryPdfDraft {
  return {
    rev: 1, step: "upload", uploadTab: "file", text: "", fileName: null, fromFile: false,
    fields: {}, owners: [], warnings: [], isLikelyScanned: false, embeddedTextLength: null,
    target: "auto", existingPropertyId: "", propertySearchQuery: "", existingProperty: null,
  };
}

/** ファイルで読んだ結果を戻した(読み取り後の段階)のに、ファイル本体が無い。 */
export function registryNeedsReselect(d: { step: string; uploadTab: "file" | "text"; fromFile: boolean; hasFile: boolean }): boolean {
  return d.step !== "upload" && d.uploadTab === "file" && d.fromFile && !d.hasFile;
}

const strOrNull = z.string().nullable();
/** 取り込みの成功の返事のうち、結果の画面が描く欄(欠けたり形が違えば画面が落ちる)。 */
const registryImportResultSchema = z.object({
  jobId: z.string().min(1),
  action: z.string(),
  propertyId: z.string().nullable(),
  parsed: z.object({
    realEstateNumber: strOrNull,
    address: strOrNull,
    lotNumber: strOrNull,
    buildingNumber: strOrNull,
    landCategory: strOrNull,
    area: strOrNull,
    owners: z.array(z.object({ name: z.string(), address: strOrNull, share: strOrNull })),
    confidence: z.number(),
    warnings: z.array(z.string()),
  }),
  warning: z.string().optional(),
});

/**
 * 謄本の取り込みの成功の返事が、結果として読める形か(@codex P2)。
 * ⚠形が違えば、取り込まれたか分からない扱い=控えと送信中の印を消さずに止める。
 */
export function isRegistryImportResult(v: unknown): boolean {
  return registryImportResultSchema.safeParse(v).success;
}
