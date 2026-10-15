/** Excel まとめ取込の下見一覧の行と、登録を試みた結果(部品 excel-lead-table.tsx から re-export)。 */
import type { PasteDraft } from "./types";
import type { LeadRowStatus } from "./lead-sheet";

export interface ExcelLeadRow {
  sheetName: string;
  rowNumber: number;
  text: string;
  draft: PasteDraft;
  ownerNote: string;
  status: LeadRowStatus;
  reasons: string[];
  registeredPropertyId: string | null;
}

/** 登録を試みた結果。 */
export type ExcelLeadResult =
  | { kind: "created"; propertyId: string }
  | { kind: "duplicate" }
  /** 登録直前の見直しで候補が見つかり、登録しなかった(人が確かめる)。 */
  | { kind: "review"; reasons: string[] }
  | { kind: "failed"; message: string }
  /** 登録されたか分からない(送った直後に画面を離れた・5xx・通信切れ。設計書 §5.2)。まとめて登録の対象から外す。 */
  | { kind: "unknown" };
