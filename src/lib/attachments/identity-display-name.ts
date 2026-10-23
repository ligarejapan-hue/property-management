/**
 * 本人確認書類(種類 docKind="identity_document")の**手元に落ちる名前を作る唯一の決まりごと**(2026-10-24)。
 *
 * 本人確認書類(運転免許証・マイナンバーカードなど)は所有者の氏名・住所・顔写真が載る。
 * 開けるのは反響資料・査定報告書と同じ「所有者の項目をすべて素通しで見られる人」だけで、
 * キャッシュさせない(uploads-authorization.ts の isOwnerPiiDocument)。
 * ⚠手元に落ちる名前は「種類」と「登録日」という非PIIの材料だけから組み立てる
 *   (referral / report と同じ姿勢)。拡張子だけは実体に合わせる(画像のことが多い)。
 */
import { toJstDateString, encodeRfc5987 } from "./registry-display-name";

/** 本人確認書類の種類 code(src/lib/doc-classify/classify.ts の DOC_KINDS と同じ値)。 */
export const IDENTITY_DOC_KIND = "identity_document";

function safeExt(ext: string | null | undefined): string {
  const e = (ext ?? "").toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(e) ? e : "bin";
}

/**
 * 本人確認書類の保存名。
 *   identityDisplayName(2026-10-24, "jpg") => "本人確認書類_2026-10-24.jpg"
 */
export function identityDisplayName(createdAt: Date | string | number | null | undefined, ext: string | null | undefined): string {
  const date = toJstDateString(createdAt);
  const e = safeExt(ext);
  return date === null ? `本人確認書類.${e}` : `本人確認書類_${date}.${e}`;
}

/** 本人確認書類の Content-Disposition(referral / report と同じ形)。 */
export function identityContentDisposition(args: {
  downloadIntent: boolean;
  createdAt?: Date | string | number | null;
  ext?: string | null;
}): string {
  if (!args.downloadIntent) return "inline";
  const name = identityDisplayName(args.createdAt, args.ext);
  return [
    "attachment",
    `filename="identity.${safeExt(args.ext)}"`,
    `filename*=UTF-8''${encodeRfc5987(name)}`,
  ].join("; ");
}
