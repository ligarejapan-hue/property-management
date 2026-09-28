import { DESK_PROPERTY_SELECT, toDeskProperty, type DeskPropertyRow } from "./desk-property";

/** 反響の一覧・詳細で読む列。物件は許可リスト用の列だけ。 */
export const INQUIRY_LIST_SELECT = {
  id: true,
  kind: true,
  status: true,
  channel: true,
  receivedAt: true,
  version: true,
  contactName: true,
  contactMobile: true,
  contactEmail: true,
  note: true,
  assignee: { select: { id: true, name: true } },
  agent: { select: { id: true, companyName: true, branchName: true, phone: true } },
  viewings: {
    orderBy: { scheduledAt: "asc" as const },
    select: {
      id: true,
      scheduledAt: true,
      viewingType: true,
      canceledAt: true,
      resultNote: true,
      // 内見の変更は版番号が要る(PATCH の前提)。画面が読み直したときにも渡す(@codex #454 R4)。
      version: true,
      attendant: { select: { id: true, name: true } },
    },
  },
  property: { select: DESK_PROPERTY_SELECT },
} as const;

/** 反響を画面に返す形。物件は必ず許可リスト(toDeskProperty)を通す。 */
export function toInquiryView<T extends { property: DeskPropertyRow }>(row: T) {
  const { property, ...rest } = row;
  return { ...rest, property: toDeskProperty(property) };
}
