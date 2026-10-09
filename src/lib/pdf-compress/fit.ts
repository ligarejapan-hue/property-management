/**
 * 添付の入口から使う: 上限を超えた PDF を縮めて、保存してよい形にする。
 * 上限以下ならそのまま返す(手を触れない)。縮められなければ 422 で理由を返す。
 */
import { ApiError } from "@/lib/api-helpers";
import { MULTIPART_OVERHEAD_BYTES } from "@/lib/import-body-size";
import { MAX_FILE_SIZE } from "@/lib/storage/types";
import { compressBusyMessage, compressFailureMessage } from "./policy";
import {
  compressPdf,
  tryReserveCompressionSlot,
  type PdfCompressLevel,
  type RunDeps,
} from "./run";

export interface FittedPdf {
  buffer: Buffer;
  /** 縮めたときだけ、圧縮前の大きさ(bytes)。縮めていなければ null。 */
  originalSize: number | null;
  level: PdfCompressLevel | null;
}

const NO_OP = () => {};

/**
 * 圧縮が要るかもしれない大きさの送信なら、**本文を読む前に**圧縮の席を取る。
 * 取れなければ 503(いま別の大きいPDFを圧縮中)。返した関数は finally で必ず呼ぶ。
 * ⚠申告(Content-Length)が上限+上乗せ分以下なら圧縮は要らないので席を取らない。
 */
export function reserveLargePdfSlot(
  request: { headers: { get(name: string): string | null } },
  reserve: () => (() => void) | null = tryReserveCompressionSlot,
): () => void {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (!Number.isFinite(declared) || declared <= MAX_FILE_SIZE + MULTIPART_OVERHEAD_BYTES) return NO_OP;
  const release = reserve();
  if (release === null) throw new ApiError(503, compressBusyMessage(), "BUSY");
  return release;
}

export async function fitPdfToLimit(
  buffer: Buffer,
  opts: { limitBytes?: number; deps?: RunDeps } = {},
): Promise<FittedPdf> {
  const limitBytes = opts.limitBytes ?? MAX_FILE_SIZE;
  if (buffer.length <= limitBytes) return { buffer, originalSize: null, level: null };
  const r = await compressPdf(buffer, limitBytes, opts.deps);
  if (!r.ok) {
    throw new ApiError(
      422,
      compressFailureMessage(r.reason, { inBytes: r.inBytes, bestBytes: r.bestBytes, limitBytes }),
      "VALIDATION_ERROR",
    );
  }
  return { buffer: r.buffer, originalSize: r.inBytes, level: r.level };
}
