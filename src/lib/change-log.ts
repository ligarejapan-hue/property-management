import prisma from "@/lib/prisma";

// Tracked-fields 定数は Prisma-free な src/lib/property-field-constants.ts に置き、
// ここでは後方互換のため re-export する。これにより
// src/lib/import-rollback.ts のような Prisma-free helper が
// PROPERTY_TRACKED_FIELDS だけ取りたいときに change-log → prisma を巻き込まない。
export {
  PROPERTY_TRACKED_FIELDS,
  OWNER_TRACKED_FIELDS,
  BUILDING_TRACKED_FIELDS,
} from "./property-field-constants";

interface RecordChangesInput {
  targetTable: string;
  targetId: string;
  changedBy: string;
  oldValues: Record<string, unknown>;
  newValues: Record<string, unknown>;
  trackedFields: string[];
  source?: "manual" | "api" | "csv_import" | "pdf_import";
}

export interface ChangeLogEntry {
  targetTable: string;
  targetId: string;
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
  source: "manual" | "api" | "csv_import" | "pdf_import";
  changedBy: string;
}

/** recordChanges / recordChangesInTx が書く行(値が変わった追跡項目だけ)。純関数。 */
export function buildChangeLogEntries(input: RecordChangesInput): ChangeLogEntry[] {
  const entries: ChangeLogEntry[] = [];

  for (const field of input.trackedFields) {
    if (!(field in input.newValues)) continue;

    const oldVal = input.oldValues[field];
    const newVal = input.newValues[field];
    const oldStr = oldVal != null ? String(oldVal) : null;
    const newStr = newVal != null ? String(newVal) : null;

    if (oldStr !== newStr) {
      entries.push({
        targetTable: input.targetTable,
        targetId: input.targetId,
        fieldName: field,
        oldValue: oldStr,
        newValue: newStr,
        source: input.source ?? "manual",
        changedBy: input.changedBy,
      });
    }
  }
  return entries;
}

/**
 * 変更ログを**呼び出し側のトランザクションで**書く。失敗は握りつぶさずに投げる
 * (=tx ごと巻き戻る)。取込の取り消しが頼る行(CSV 重複更新の前の値)はこちらで書く。
 * 行の形は recordChanges と同じ。
 */
export async function recordChangesInTx(
  tx: { changeLog: { createMany: (args: { data: ChangeLogEntry[] }) => Promise<unknown> } },
  input: RecordChangesInput,
): Promise<void> {
  const entries = buildChangeLogEntries(input);
  if (entries.length > 0) {
    await tx.changeLog.createMany({ data: entries });
  }
}

export async function recordChanges(input: RecordChangesInput): Promise<void> {
  if (process.env.NEXT_PUBLIC_USE_MOCK === "true") return;

  const entries = buildChangeLogEntries(input);
  if (entries.length > 0) {
    try {
      await prisma.changeLog.createMany({ data: entries });
    } catch (err) {
      console.error("Failed to record change logs:", err);
    }
  }
}
