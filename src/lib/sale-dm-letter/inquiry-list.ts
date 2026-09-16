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
  /** 電話・希望連絡方法・時間帯・要望・対応メモ handleNote(email を除く)を権限不足で伏せたか。対応メモは折り返し番号などを含みうるため一緒に伏せる(@codex P1) */
  contactHidden: boolean;
  /** メール(owner_email の表示レベル)を権限不足で伏せたか。phone/contact の可否とは独立に決まる(@codex P2) */
  emailHidden: boolean;
}

type SourceRow = Omit<InquiryListRow, "contactHidden" | "emailHidden" | "phone"> & { phone: string };

/** 連絡先の表示可否。email は phone とは別の owner_email 表示レベルで決まる(@codex P1)。 */
export interface InquiryVisibility {
  contact: boolean;
  email: boolean;
}

export function toInquiryListRows(rows: SourceRow[], visibility: InquiryVisibility): InquiryListRow[] {
  // 並べ替えはしない: DB が submittedAt desc, id desc の不変順で返す(@codex P2)。
  // email は phone/contact とは別の owner_email 表示レベルで独立に決まる(@codex P2):
  // 「電話は伏せるがメールは表示する」も成立する組み合わせのため、それぞれ個別に算出する。
  return rows.map((r) => ({
    ...r,
    phone: visibility.contact ? r.phone : null,
    contactPref: visibility.contact ? r.contactPref : null,
    contactTime: visibility.contact ? r.contactTime : null,
    message: visibility.contact ? r.message : null,
    handleNote: visibility.contact ? r.handleNote : null,
    contactHidden: !visibility.contact,
    email: visibility.email ? r.email : null,
    emailHidden: !visibility.email,
  }));
}

/**
 * 状態別の件数(groupBy の結果)を「対応が必要」(未対応・対応中)と「対応済み」にまとめる。
 * 未知の状態は取りこぼさないよう「対応が必要」に数える。
 */
export function countInquiriesByGroup(groups: Array<{ handleStatus: string; _count: { _all: number } }>): { active: number; done: number } {
  let active = 0;
  let done = 0;
  for (const g of groups) {
    if (g.handleStatus === "done") done += g._count._all;
    else active += g._count._all;
  }
  return { active, done };
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
