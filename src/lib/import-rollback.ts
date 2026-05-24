/**
 * CSV取込ロールバックの行分類ロジック。
 * Prisma 非依存でテスト可能な純関数のみを置く。
 */

import { isUpdateMessage } from "./import-row-display";
import { PROPERTY_TRACKED_FIELDS } from "./change-log";
import { UPDATABLE_PROPERTY_FIELDS } from "./import-dedupe";

export type RollbackCategory = "delete" | "restore" | "skip";

interface RowInput {
  id: string;
  rowNumber: number;
  status: "success" | "error" | "skipped" | "needs_review";
  errorMessage: string | null;
  createdId: string | null;
}

export interface ClassifiedRow {
  rowId: string;
  rowNumber: number;
  createdId: string | null;
  category: RollbackCategory;
}

/**
 * - delete: success + 新規作成 (errorMessage が「更新」で始まらない) + createdId あり
 * - restore: success + 更新 (isUpdateMessage true) + createdId あり
 * - skip: 上記以外（needs_review / error / skipped、または createdId なし）
 */
export function classifyRowsForRollback(rows: RowInput[]): ClassifiedRow[] {
  return rows.map((r) => {
    if (r.status === "success" && r.createdId) {
      return {
        rowId: r.id,
        rowNumber: r.rowNumber,
        createdId: r.createdId,
        category: isUpdateMessage(r.errorMessage) ? "restore" : "delete",
      };
    }
    return {
      rowId: r.id,
      rowNumber: r.rowNumber,
      createdId: r.createdId,
      category: "skip",
    };
  });
}

// ---------------------------------------------------------------------------
// Phase 2: property_csv 更新行の field 復元判定（純関数）
// ---------------------------------------------------------------------------

/** Phase 2 復元対象 = UPDATABLE_PROPERTY_FIELDS ∩ PROPERTY_TRACKED_FIELDS */
export const RESTORABLE_PROPERTY_FIELDS = UPDATABLE_PROPERTY_FIELDS.filter(
  (f) => (PROPERTY_TRACKED_FIELDS as readonly string[]).includes(f),
) as readonly string[];

type FieldType = "string" | "int" | "decimal";

/** 復元対象 field の Prisma 型マップ（型変換に利用）。schema.prisma 準拠。 */
export const RESTORABLE_PROPERTY_FIELD_TYPES: Record<string, FieldType> = {
  address: "string",
  lotNumber: "string",
  buildingNumber: "string",
  introductionRoute: "string",
  zoningDistrict: "string",
  note: "string",
  rosenkaValue: "int",
  gpsLat: "decimal",
  gpsLng: "decimal",
};

export type FieldRestoreStatus =
  | "restorable"
  | "skip_no_changelog"
  | "skip_not_restorable_field"
  | "skip_subsequent_edit"
  | "skip_type_conversion_failed";

export interface FieldRestoreDecision {
  fieldName: string;
  status: FieldRestoreStatus;
  /** 復元時に Prisma.update に渡す値（type 変換済み）。restorable のときのみ非 null */
  restoreValue: string | number | null;
  /** restorable === false のときの理由（UI / blockedDetails 用、PII を含まない） */
  reason?: string;
}

interface ChangeLogInput {
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
  source: "manual" | "api" | "csv_import" | "pdf_import";
  changedAt: Date;
}

/** ChangeLog の文字列値を Prisma に渡す型に変換。失敗時は throw。 */
function convertOldValueToFieldType(
  rawOldValue: string | null,
  type: FieldType,
): string | number | null {
  if (rawOldValue == null) return null;
  if (type === "string") return rawOldValue;
  if (type === "int") {
    const n = Number(rawOldValue);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      throw new Error(`int parse failed: ${rawOldValue}`);
    }
    return n;
  }
  // decimal: Prisma は number でも文字列でも受け付けるが、Number に通る値かだけ検証
  const n = Number(rawOldValue);
  if (!Number.isFinite(n)) {
    throw new Error(`decimal parse failed: ${rawOldValue}`);
  }
  return rawOldValue;
}

const TOLERANCE_MS = 5000;

/**
 * 1 Property の更新行に対し、復元可能な field の集合を判定する。
 *
 * 復元可能条件（per field）:
 *  - field が RESTORABLE_PROPERTY_FIELDS に含まれる
 *  - job 完了時刻の近傍 (±TOLERANCE_MS) に source=csv_import の ChangeLog が存在する
 *  - その ChangeLog 以降に同 field の手動編集 (source ≠ csv_import) がない
 *  - oldValue を Prisma 型に変換できる
 *
 * PII を返さないため、UI/AuditLog 側で「field 名」のみを利用する想定。
 *
 * @param changeLogs 対象 Property の ChangeLog（target_table=properties, target_id=propertyId）
 * @param completedAtMs ImportJob.completedAt の epoch ms
 */
export function classifyUpdateFieldsForRestore(
  changeLogs: ChangeLogInput[],
  completedAtMs: number,
): FieldRestoreDecision[] {
  const byField = new Map<string, ChangeLogInput[]>();
  for (const log of changeLogs) {
    const arr = byField.get(log.fieldName) ?? [];
    arr.push(log);
    byField.set(log.fieldName, arr);
  }
  // 時系列昇順に並べる（同時刻は配列順）
  for (const arr of byField.values()) {
    arr.sort((a, b) => a.changedAt.getTime() - b.changedAt.getTime());
  }

  const decisions: FieldRestoreDecision[] = [];
  for (const fieldName of byField.keys()) {
    const logs = byField.get(fieldName)!;

    if (!RESTORABLE_PROPERTY_FIELDS.includes(fieldName)) {
      decisions.push({
        fieldName,
        status: "skip_not_restorable_field",
        restoreValue: null,
        reason: "復元対象外フィールド",
      });
      continue;
    }

    // job 完了時刻の近傍にある csv_import ログを探す
    const csvLog = logs.find(
      (l) =>
        l.source === "csv_import" &&
        Math.abs(l.changedAt.getTime() - completedAtMs) <= TOLERANCE_MS,
    );
    if (!csvLog) {
      decisions.push({
        fieldName,
        status: "skip_no_changelog",
        restoreValue: null,
        reason: "このジョブが記録した変更ログが見つかりません",
      });
      continue;
    }

    // その csv_import より後の同 field の編集（manual / api / pdf_import）があるか
    const subsequent = logs.find(
      (l) =>
        l.changedAt.getTime() > csvLog.changedAt.getTime() &&
        l.source !== "csv_import",
    );
    if (subsequent) {
      decisions.push({
        fieldName,
        status: "skip_subsequent_edit",
        restoreValue: null,
        reason: "取込後に手動編集されているため復元しません",
      });
      continue;
    }

    const fieldType = RESTORABLE_PROPERTY_FIELD_TYPES[fieldName];
    try {
      const restoreValue = convertOldValueToFieldType(
        csvLog.oldValue,
        fieldType,
      );
      decisions.push({
        fieldName,
        status: "restorable",
        restoreValue,
      });
    } catch {
      decisions.push({
        fieldName,
        status: "skip_type_conversion_failed",
        restoreValue: null,
        reason: "値の型変換に失敗したため復元できません",
      });
    }
  }

  return decisions;
}
