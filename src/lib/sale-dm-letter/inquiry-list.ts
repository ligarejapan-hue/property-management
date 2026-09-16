/** 社内の申込一覧の並べ替えと連絡先の伏せ(純関数)。 */
export const HANDLE_STATUSES = ["open", "in_progress", "done"] as const;
export type HandleStatus = (typeof HANDLE_STATUSES)[number];

export interface InquiryListRow {
  id: string;
  draftId: string;
  submittedAt: Date;
  name: string;
  phone: string | null;
  email: string | null;
  contactPref: string | null;
  contactTime: string | null;
  message: string | null;
  handleStatus: string;
  handledAt: Date | null;
  handleNote: string | null;
  /** 連絡先(電話・メール・希望連絡方法・時間帯・要望)を権限不足で伏せたか */
  contactHidden: boolean;
}

type SourceRow = Omit<InquiryListRow, "contactHidden" | "phone"> & { phone: string };

const ORDER: Record<string, number> = { open: 0, in_progress: 1, done: 2 };

export function toInquiryListRows(rows: SourceRow[], showContact: boolean): InquiryListRow[] {
  return [...rows]
    .sort((a, b) => (ORDER[a.handleStatus] ?? 9) - (ORDER[b.handleStatus] ?? 9) || b.submittedAt.getTime() - a.submittedAt.getTime())
    .map((r) => (showContact
      ? { ...r, contactHidden: false }
      : { ...r, phone: null, email: null, contactPref: null, contactTime: null, message: null, contactHidden: true }));
}
