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
  /**
   * Excel の担当者の列の値(従業員の指摘⑨ 2026-10-25)。列が無い・空なら null。
   * ⚠省略可=この項目より前に保存した作業中の控えには無い。
   */
  assigneeLabel?: string | null;
  /** 登録で物件の担当者にする人(ユーザーの id)。読み取りで1人に決まれば入り、画面で選び直せる。null=担当者なし。 */
  assignedTo?: string | null;
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
