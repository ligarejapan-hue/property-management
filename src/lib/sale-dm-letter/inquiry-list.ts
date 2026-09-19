/** 社内の申込一覧の区分・カーソルと連絡先の伏せ(純関数)。 */
import { NAME_CONTACT_LIKE_RE } from "./inquiry-input";

/** 数字や @ を含むお名前(連絡先が紛れた可能性)を、自由記述を見られない利用者に出すときの代わりの表示 */
export const HIDDEN_NAME_PLACEHOLDER = "(お名前は表示する権限がありません)";
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
  /** 通知メールの送信状況(pending/sending/sent/failed)。個人情報ではないので伏せ対象にしない。 */
  notifyStatus: string;
  /** 電話・希望連絡方法(enum の contactPref。構造化された連絡先項目。email を除く)を
   *  権限不足で伏せたか。contactTime・message・handleNote はここには連動しない
   *  (自由記述なので下の freeTextHidden を見る)。 */
  contactHidden: boolean;
  /** メール(owner_email の表示レベル)を権限不足で伏せたか。phone/contact の可否とは独立に決まる(@codex P2) */
  emailHidden: boolean;
  /** 自由記述(contactTime=連絡のつきやすい時間帯・message=申込者の要望・handleNote=対応メモ)を
   *  権限不足で伏せたか。自由記述は申込者が自由に書けるためメールアドレスなど email 相当の
   *  情報を含みうる(contactTime も例外ではない・@codex L1 P1)ので、phone(contact)と
   *  email の**両方**を見られる利用者にだけ返す(= !(contact && email))(@codex R10 P1)。 */
  freeTextHidden: boolean;
}

type SourceRow = Omit<InquiryListRow, "contactHidden" | "emailHidden" | "freeTextHidden" | "phone"> & { phone: string };

/** 連絡先の表示可否。email は phone とは別の owner_email 表示レベルで決まる(@codex P1)。 */
export interface InquiryVisibility {
  contact: boolean;
  email: boolean;
}

export function toInquiryListRows(rows: SourceRow[], visibility: InquiryVisibility): InquiryListRow[] {
  // 並べ替えはしない: DB が submittedAt desc, id desc の不変順で返す(@codex P2)。
  // email は phone/contact とは別の owner_email 表示レベルで独立に決まる(@codex P2):
  // 「電話は伏せるがメールは表示する」も成立する組み合わせのため、それぞれ個別に算出する。
  // contactTime/message/handleNote は自由記述でメールアドレス等を含みうるため、contact と
  // email の**両方**を見られる利用者にだけ返す(@codex R10 P1・contactTime は L1 P1)。
  // 構造化項目(phone/contactPref)は contact だけ、email は email だけで独立に決まる(従来どおり)。
  const freeTextVisible = visibility.contact && visibility.email;
  return rows.map((r) => ({
    ...r,
    // お名前は常に出すが、数字や @ を含む(=電話・メールが紛れた可能性がある)ときは自由記述と同じ扱い(@codex R13 P1)。
    name: freeTextVisible || !NAME_CONTACT_LIKE_RE.test(r.name.normalize("NFKC")) ? r.name : HIDDEN_NAME_PLACEHOLDER,
    phone: visibility.contact ? r.phone : null,
    contactPref: visibility.contact ? r.contactPref : null,
    contactTime: freeTextVisible ? r.contactTime : null,
    message: freeTextVisible ? r.message : null,
    handleNote: freeTextVisible ? r.handleNote : null,
    contactHidden: !visibility.contact,
    email: visibility.email ? r.email : null,
    emailHidden: !visibility.email,
    freeTextHidden: !freeTextVisible,
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
