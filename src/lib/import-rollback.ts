/**
 * CSV取込ロールバックの行分類ロジック。
 * Prisma 非依存でテスト可能な純関数のみを置く。
 */

import { isUpdateMessage } from "./import-row-display";

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
