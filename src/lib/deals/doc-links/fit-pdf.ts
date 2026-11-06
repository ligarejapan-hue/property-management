import { compressPdf } from "@/lib/pdf-compress/run";
import { DOC_FILE_ACCEPT_BYTES, DOC_FILE_MAX_BYTES, DOC_PDF_COMPRESS_TIMEOUT_MS } from "./constants";

export type FittedSubmittedPdf = { ok: true; buffer: Buffer; compressed: boolean } | { ok: false; reason: "too_large" | "encrypted" | "unreadable" };

/**
 * お客様が送った PDF を、8MB を超えていれば縮める(2026-11-06 発注者「8MBを超えたら自動圧縮」)。
 * 社内の添付と同じ決まり: 8MB 以下には手を触れない・目標は 8MB・届かなくても 20MB 以下なら保存する。
 * ⚠8MB を超えたものを元のまま保存するのは、PDF として読めたうえで縮みきらなかったときだけ
 *   (ログインなしの口なので、読めない・パスワード付き・圧縮できなかったものを大きいまま置かない)。
 * ⚠呼ぶ前に圧縮の席を取っておくこと(受け口が本文を読む前に取る)。
 * ⚠1回の時間の上限は 60 秒(社内の添付は 2 分)。時間切れは "error"=断る。
 */
export async function fitSubmittedPdf(buffer: Buffer, compress: typeof compressPdf = compressPdf): Promise<FittedSubmittedPdf> {
  if (buffer.length <= DOC_FILE_MAX_BYTES) return { ok: true, buffer, compressed: false };
  const r = await compress(buffer, DOC_FILE_MAX_BYTES, undefined, DOC_FILE_ACCEPT_BYTES, DOC_PDF_COMPRESS_TIMEOUT_MS);
  if (r.ok) return r.buffer.length < buffer.length ? { ok: true, buffer: r.buffer, compressed: true } : { ok: true, buffer, compressed: false };
  if (r.reason === "too_large" && buffer.length <= DOC_FILE_ACCEPT_BYTES) return { ok: true, buffer, compressed: false };
  if (r.reason === "encrypted") return { ok: false, reason: "encrypted" };
  if (r.reason === "invalid_pdf") return { ok: false, reason: "unreadable" };
  return { ok: false, reason: "too_large" };
}
