import { NAME_CONTACT_LIKE_RE } from "./inquiry-input";
import { HIDDEN_NAME_PLACEHOLDER } from "./inquiry-list";

export interface InquiryNotifyFacts {
  inquiryId: string;
  submittedAt: Date;
  campaignName: string;
  dmVariantLabel: string | null;
  lpVariantLabel: string | null;
  location: string | null;
  propertyTypeLabel: string | null;
  name: string;
  phone: string;
  email: string | null;
  contactPref: string | null;
  contactTime: string | null;
  message: string | null;
}

const PREF_LABEL: Record<string, string> = { phone: "電話", email: "メール", either: "どちらでも" };
const SUBJECT_MAX = 120;

export function formatJst(d: Date): string {
  const j = new Date(d.getTime() + 9 * 3_600_000);
  const hh = String(j.getUTCHours()).padStart(2, "0");
  const mm = String(j.getUTCMinutes()).padStart(2, "0");
  return `${j.getUTCFullYear()}年${j.getUTCMonth() + 1}月${j.getUTCDate()}日 ${hh}:${mm}`;
}

function oneLine(s: string): string {
  return s.replace(/[\r\n]+/g, " ");
}

// 通知メールの件名・本文(設計 §2.6)。detail は受け手ごとに呼び出し側が決める(表示権限の弱い人は minimal)。
export function buildInquiryNotifyMail(
  f: InquiryNotifyFacts,
  opts: { detail: "minimal" | "full"; appBaseUrl: string | null },
): { subject: string; text: string } {
  const place = oneLine(f.location ?? "所在地不明");
  const kind = oneLine(f.propertyTypeLabel ?? "物件");
  const subject = [...`【査定申込】${place}の${kind}(${oneLine(f.campaignName)})`].slice(0, SUBJECT_MAX).join("");
  const full = opts.detail === "full";
  const name = !full && NAME_CONTACT_LIKE_RE.test(f.name.normalize("NFKC")) ? HIDDEN_NAME_PLACEHOLDER : oneLine(f.name);

  const lines = [
    "公開LPから査定のお申込みが届きました。",
    "",
    `受付日時: ${formatJst(f.submittedAt)}`,
    `キャンペーン: ${oneLine(f.campaignName)}`,
    `DM型: ${oneLine(f.dmVariantLabel ?? "-")} / LP型: ${oneLine(f.lpVariantLabel ?? "-")}`,
    `物件: ${place}の${kind}`,
    `お名前: ${name}`,
  ];
  if (full) {
    lines.push(`電話: ${f.phone}`);
    if (f.email) lines.push(`メール: ${f.email}`);
    if (f.contactPref) lines.push(`希望の連絡方法: ${PREF_LABEL[f.contactPref] ?? "-"}`);
    if (f.contactTime) lines.push(`連絡のつきやすい時間帯: ${oneLine(f.contactTime)}`);
    if (f.message) lines.push("", "ご要望・ご質問:", f.message);
  }
  lines.push("");
  if (opts.appBaseUrl) {
    const base = opts.appBaseUrl.replace(/\/+$/, "");
    lines.push("アプリで開く:", `${base}/properties/sale-dm/inquiries?focus=${encodeURIComponent(f.inquiryId)}`);
  } else {
    lines.push("アプリの「査定の申込」からご確認ください。");
  }
  lines.push("", "※このメールは物件管理システムから自動で送っています。返信しても届きません。");
  return { subject, text: lines.join("\n") };
}
