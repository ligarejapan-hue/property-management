/** 社内の申込一覧の区分・カーソルと連絡先の伏せ(純関数)。 */
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
  /** 連絡先(電話・メール・希望連絡方法・時間帯・要望・対応メモ handleNote)を権限不足で伏せたか。対応メモは折り返し番号などを含みうるため一緒に伏せる(@codex P1) */
  contactHidden: boolean;
  /** メール(owner_email の表示レベル)を権限不足で伏せたか */
  emailHidden: boolean;
}

type SourceRow = Omit<InquiryListRow, "contactHidden" | "emailHidden" | "phone"> & { phone: string };

/** 連絡先の表示可否。email は phone とは別の owner_email 表示レベルで決まる(@codex P1)。 */
export interface InquiryVisibility {
  contact: boolean;
  email: boolean;
}

export function toInquiryListRows(rows: SourceRow[], visibility: InquiryVisibility): InquiryListRow[] {
  // 並べ替えはしない: 区分(segment)ごとに DB が submittedAt desc, id desc の不変順で返す(@codex P2)。
  return rows.map((r) => {
    if (!visibility.contact) {
      return { ...r, phone: null, email: null, contactPref: null, contactTime: null, message: null, handleNote: null, contactHidden: true, emailHidden: true };
    }
    if (!visibility.email) {
      return { ...r, email: null, contactHidden: false, emailHidden: true };
    }
    return { ...r, contactHidden: false, emailHidden: false };
  });
}

/**
 * 一覧の区分(@codex P2)。状態が変わると行が区分をまたぐため、区分ごとに独立してたどる。
 * active=未対応・対応中(先に表示)/ done=対応済み。
 */
export const INQUIRY_SEGMENTS = ["active", "done"] as const;
export type InquirySegment = (typeof INQUIRY_SEGMENTS)[number];

export function isInquirySegment(v: string): v is InquirySegment {
  return (INQUIRY_SEGMENTS as readonly string[]).includes(v);
}

export function inquirySegmentWhere(segment: InquirySegment) {
  return segment === "done" ? { handleStatus: "done" } : { handleStatus: { in: ["open", "in_progress"] } };
}

/** キーセットのカーソル = base64url(JSON {t: submittedAt ISO, i: id})。並びは submittedAt desc, id desc。 */
export interface InquiryCursor {
  t: Date;
  i: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeInquiryCursor(row: { submittedAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ t: row.submittedAt.toISOString(), i: row.id })).toString("base64url");
}

/** 不正な値(壊れた base64/JSON・日時でない・id が UUID でない)は null=先頭ページ扱い。 */
export function decodeInquiryCursor(raw: string | null): InquiryCursor | null {
  if (!raw || raw.length > 200) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const { t, i } = parsed as { t?: unknown; i?: unknown };
    if (typeof t !== "string" || typeof i !== "string" || !UUID_RE.test(i)) return null;
    const date = new Date(t);
    if (Number.isNaN(date.getTime())) return null;
    return { t: date, i };
  } catch {
    return null;
  }
}

/** カーソルより後ろ(submittedAt desc, id desc の順で次)の行だけを取る条件。 */
export function inquiryCursorWhere(cursor: InquiryCursor) {
  return { OR: [{ submittedAt: { lt: cursor.t } }, { submittedAt: cursor.t, id: { lt: cursor.i } }] };
}
