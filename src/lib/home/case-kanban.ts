/**
 * ホームの「案件の進み具合」(2026-11-10 案2)の共通部品。見るだけ(ステータスの変更は物件の画面で)。
 */
import { CASE_STATUS_LABELS, type CaseStatusValue } from "@/lib/property-types";

/** 列にする進行中の段階(この順)。未着手・完了・終了・保留・除外は列にしない。 */
export const KANBAN_STATUSES = [
  "contact_attempting",
  "contacting_owner",
  "appraisal",
  "negotiating",
  "brokerage_obtained",
  "on_sale",
  "contract_planned",
] as const satisfies readonly CaseStatusValue[];

export type KanbanStatus = (typeof KANBAN_STATUSES)[number];

/** 各列に出すカードの数。 */
export const KANBAN_CARD_LIMIT = 3;

/** カード1枚。所有者名・連絡先・緯度経度は入れない。 */
export interface KanbanCard {
  id: string;
  /** 物件の所在 */
  address: string | null;
  /** 担当者の表示名 */
  assigneeName: string | null;
  /** 最終更新(ISO) */
  updatedAt: string;
}

export interface KanbanColumn {
  status: KanbanStatus;
  label: string;
  count: number;
  cards: KanbanCard[];
}

export interface KanbanResponse {
  mine: boolean;
  columns: KanbanColumn[];
  /** 物件一覧の「担当者」の絞り込みに渡す自分の id(「ほか N 件」のリンク用) */
  selfId: string;
}

export function kanbanLabel(s: KanbanStatus): string {
  return CASE_STATUS_LABELS[s];
}

/** 「ほか N 件」の行き先=物件一覧をそのステータス(と自分の担当)で絞って開く。 */
export function kanbanListHref(status: KanbanStatus, assignedTo: string | null): string {
  const q = new URLSearchParams({ caseStatus: status });
  if (assignedTo) q.set("assignedTo", assignedTo);
  return `/properties?${q.toString()}`;
}
