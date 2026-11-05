import { compressPdf } from "@/lib/pdf-compress/run";
import { DOC_FILE_ACCEPT_BYTES, DOC_FILE_MAX_BYTES } from "./constants";

export type FittedSubmittedPdf = { ok: true; buffer: Buffer; compressed: boolean } | { ok: false; reason: "too_large" | "encrypted" };

/**
 * お客様が送った PDF を、8MB を超えていれば縮める(2026-11-06 発注者「8MBを超えたら自動圧縮」)。
 * 社内の添付と同じ決まり: 8MB 以下には手を触れない・目標は 8MB・届かなくても 20MB 以下なら保存する
 * (縮まなければ元のまま)。それでも 20MB を超えるものだけ断る。
 * ⚠呼ぶ前に圧縮の席を取っておくこと(受け口が本文を読む前に取る)。
 */
export async function fitSubmittedPdf(buffer: Buffer, compress: typeof compressPdf = compressPdf): Promise<FittedSubmittedPdf> {
  if (buffer.length <= DOC_FILE_MAX_BYTES) return { ok: true, buffer, compressed: false };
  const r = await compress(buffer, DOC_FILE_MAX_BYTES, undefined, DOC_FILE_ACCEPT_BYTES);
  if (r.ok && r.buffer.length < buffer.length) return { ok: true, buffer: r.buffer, compressed: true };
  if (buffer.length <= DOC_FILE_ACCEPT_BYTES) return { ok: true, buffer, compressed: false };
  return { ok: false, reason: !r.ok && r.reason === "encrypted" ? "encrypted" : "too_large" };
}
