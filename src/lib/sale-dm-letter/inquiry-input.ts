/**
 * 公開LPの査定申込フォームの入力検証(設計 §2.5)。純関数(env/DB 非依存)。
 * 受け口 route は FormData の get をそのまま渡す。戻り値の value だけを DB に保存する。
 */
export const INQUIRY_LIMITS = { name: 50, phone: 20, email: 254, contactTime: 60, message: 1000 } as const;
export const CONTACT_PREFS = ["phone", "email", "either"] as const;
export type ContactPref = (typeof CONTACT_PREFS)[number];
/** ボット除けの隠し欄。人には見えない位置に置き、埋まっていれば機械送信とみなす。 */
export const HONEYPOT_FIELD = "website";

export interface InquiryInput {
  name: string;
  phone: string;
  email: string | null;
  contactPref: ContactPref | null;
  contactTime: string | null;
  message: string | null;
}

export type InquiryFieldError =
  | "name_required" | "name_too_long"
  | "phone_required" | "phone_invalid"
  | "email_invalid" | "email_required_for_pref"
  | "contact_pref_invalid"
  | "contact_time_too_long"
  | "message_too_long"
  | "consent_required";

export const INQUIRY_ERROR_MESSAGES: Readonly<Record<InquiryFieldError, string>> = {
  name_required: "お名前をご入力ください。",
  name_too_long: `お名前は${INQUIRY_LIMITS.name}文字以内でご入力ください。`,
  phone_required: "電話番号をご入力ください。",
  phone_invalid: "電話番号は数字とハイフンで、10桁以上ご入力ください。",
  email_invalid: "メールアドレスの形式をご確認ください。",
  email_required_for_pref: "メールでのご連絡をご希望の場合は、メールアドレスをご入力ください。",
  contact_pref_invalid: "ご希望の連絡方法をお選びください。",
  contact_time_too_long: `連絡のつきやすい時間帯は${INQUIRY_LIMITS.contactTime}文字以内でご入力ください。`,
  message_too_long: `ご要望・ご質問は${INQUIRY_LIMITS.message}文字以内でご入力ください。`,
  consent_required: "個人情報の取り扱いへの同意が必要です。",
};

export type InquiryParse =
  | { kind: "ok"; value: InquiryInput }
  | { kind: "bot" }
  | { kind: "invalid"; errors: InquiryFieldError[] };

// 改行(\n)以外の制御文字。要望以外は改行も落とす。
const CONTROL_EXCEPT_NL = /[\u0000-\u0009\u000b-\u001f\u007f]/g;
const CONTROL_ALL = /[\u0000-\u001f\u007f]/g;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function single(v: string | null): string {
  return (v ?? "").normalize("NFKC").replace(CONTROL_ALL, "").trim();
}

function multi(v: string | null): string {
  return (v ?? "").normalize("NFKC").replace(/\r\n?/g, "\n").replace(CONTROL_EXCEPT_NL, "").trim();
}

function normalizePhone(v: string): string {
  // NFKC 後に残る長音・マイナス類をハイフンへ(全角入力の「ー」「−」)。
  return v.replace(/[ー−–—―]/g, "-");
}

export function parseInquiryForm(get: (key: string) => string | null): InquiryParse {
  if (single(get(HONEYPOT_FIELD)) !== "") return { kind: "bot" };

  const errors: InquiryFieldError[] = [];

  const name = single(get("name"));
  if (name === "") errors.push("name_required");
  else if ([...name].length > INQUIRY_LIMITS.name) errors.push("name_too_long");

  const phone = normalizePhone(single(get("phone")));
  if (phone === "") errors.push("phone_required");
  else if (
    phone.length > INQUIRY_LIMITS.phone ||
    !/^[0-9+\- ]+$/.test(phone) ||
    phone.replace(/[^0-9]/g, "").length < 10
  ) errors.push("phone_invalid");

  const emailRaw = single(get("email"));
  const email = emailRaw === "" ? null : emailRaw;
  if (email != null && (email.length > INQUIRY_LIMITS.email || !EMAIL_RE.test(email))) errors.push("email_invalid");

  const prefRaw = single(get("contactPref"));
  let contactPref: ContactPref | null = null;
  if (prefRaw !== "") {
    if ((CONTACT_PREFS as readonly string[]).includes(prefRaw)) contactPref = prefRaw as ContactPref;
    else errors.push("contact_pref_invalid");
  }
  if (contactPref === "email" && email == null) errors.push("email_required_for_pref");

  const timeRaw = single(get("contactTime"));
  const contactTime = timeRaw === "" ? null : timeRaw;
  if (contactTime != null && [...contactTime].length > INQUIRY_LIMITS.contactTime) errors.push("contact_time_too_long");

  const msgRaw = multi(get("message"));
  const message = msgRaw === "" ? null : msgRaw;
  if (message != null && [...message].length > INQUIRY_LIMITS.message) errors.push("message_too_long");

  if (single(get("consent")) !== "yes") errors.push("consent_required");

  if (errors.length > 0) return { kind: "invalid", errors };
  return { kind: "ok", value: { name, phone, email, contactPref, contactTime, message } };
}
