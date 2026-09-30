/** 申込者への受付メール(自動返信)の件名・本文(純関数)。 */

export const AUTO_REPLY_LIMITS = { subject: 120, body: 2000 } as const;

export interface AutoReplySender {
  senderName: string | null;
  senderContact: string | null;
}

export interface AutoReplyTemplate {
  subject: string | null;
  body: string | null;
}

function oneLine(s: string): string {
  return s.replace(/[\r\n]+/g, " ").trim();
}

function filled(s: string | null): string | null {
  return s !== null && s.trim() !== "" ? s : null;
}

export function defaultAutoReplySubject(sender: AutoReplySender): string {
  const name = oneLine(sender.senderName ?? "");
  return name ? `【${name}】査定のお申し込みを受け付けました` : "査定のお申し込みを受け付けました";
}

export function defaultAutoReplyBody(sender: AutoReplySender): string {
  const lines = [
    "このたびは査定のお申し込みをいただき、ありがとうございます。",
    "内容を確認のうえ、担当者よりご連絡いたします。",
    "",
    "お心当たりのない場合は、お手数ですがこのメールを破棄してください。",
  ];
  const signature = [oneLine(sender.senderName ?? ""), oneLine(sender.senderContact ?? "")].filter((s) => s !== "");
  if (signature.length > 0) lines.push("", ...signature);
  return lines.join("\n");
}

// 画面で入れた件名・本文があればそれを、無ければ既定の文面を使う(件名と本文は別々に判定)。
// ⚠引数は「画面の文面」と「差出人」だけ。申込者の入力(お名前・電話・要望)を受け取る口を作らない=
//   フォームに他人のアドレスを書かれても、その人に届くのは決まった文面だけになる。
export function buildInquiryAutoReplyMail(
  template: AutoReplyTemplate,
  sender: AutoReplySender,
): { subject: string; text: string } {
  const subject = [...oneLine(filled(template.subject) ?? defaultAutoReplySubject(sender))]
    .slice(0, AUTO_REPLY_LIMITS.subject)
    .join("");
  const text = (filled(template.body) ?? defaultAutoReplyBody(sender)).replace(/\r\n?/g, "\n");
  return { subject, text };
}
