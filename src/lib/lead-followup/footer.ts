/**
 * 追客メールの末尾(特定電子メール法の表示)。純関数。
 * 設計: docs/superpowers/specs/2026-11-16-inquiry-followup-mail-design.md §5
 *
 * - 送信者名・住所・問い合わせ先(電話かメール)・配信停止のリンクを必ず付ける。本文の欄からは消せない。
 * - 最初の1通だけ「お心当たりのない場合は…」を足す(アドレスが本人のものかを確かめていないため)。
 * - どれかが欠けていたら送らない(ON の保存も断る)=followupSenderProblems が空でないとき。
 */

export type FollowupSender = {
  companyName: string | null;
  address: string | null;
  tel: string | null;
  email: string | null;
};

const clean = (v: string | null | undefined): string | null => {
  if (v == null) return null;
  // 1行に収める(会社の設定に改行が入っていても、表示の行を崩さない)。
  const one = v.replace(/[\r\n\t]+/g, " ").trim();
  return one === "" ? null : one;
};

export function normalizeFollowupSender(raw: Partial<FollowupSender> | null | undefined): FollowupSender {
  return {
    companyName: clean(raw?.companyName),
    address: clean(raw?.address),
    tel: clean(raw?.tel),
    email: clean(raw?.email),
  };
}

/** 送るために足りないもの(日本語)。空=送ってよい。 */
export function followupSenderProblems(sender: FollowupSender, unsubscribeBaseUrl: string | null | undefined): string[] {
  const problems: string[] = [];
  if (!sender.companyName) problems.push("会社の設定に会社名がありません");
  if (!sender.address) problems.push("会社の設定に住所がありません");
  if (!sender.tel && !sender.email) problems.push("会社の設定に電話番号もメールアドレスもありません");
  if (!unsubscribeBaseUrl) problems.push("配信停止のリンクに使う外向きのURL(売却DM設定の追跡URL)がありません");
  return problems;
}

export const FIRST_MAIL_NOTICE = "お心当たりのない場合は、お手数ですが下の配信停止を押してください。";
const RULE = "──────────────";

/** 末尾の文。sender は followupSenderProblems が空であること(欠けた項目の行は出さない)。 */
export function buildFollowupFooter(args: {
  sender: FollowupSender;
  unsubscribeUrl: string;
  first: boolean;
}): string {
  const { sender, unsubscribeUrl, first } = args;
  const contact = [sender.tel, sender.email].filter((v): v is string => !!v).join(" / ");
  const lines: string[] = [];
  if (first) lines.push(FIRST_MAIL_NOTICE, "");
  lines.push(RULE);
  if (sender.companyName) lines.push(`送信者: ${sender.companyName}`);
  if (sender.address) lines.push(`住所: ${sender.address}`);
  if (contact) lines.push(`お問い合わせ: ${contact}`);
  lines.push(
    "このメールは査定のお申し込みをいただいた方にお送りしています。",
    "今後のご案内が不要な場合は、こちらから配信を停止できます:",
    unsubscribeUrl,
  );
  return lines.join("\n");
}

/** 送る本文=登録した本文+空行+末尾。本文の末尾の空行は1つにまとめる。 */
export function composeFollowupText(body: string, footer: string): string {
  return `${body.replace(/\s+$/, "")}\n\n${footer}\n`;
}
