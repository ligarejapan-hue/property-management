/**
 * 添付の入口から使う: 上限を超えた PDF を縮めて、保存してよい形にする。
 * 上限以下ならそのまま返す(手を触れない)。縮められなければ 422 で理由を返す。
 */
import { ApiError } from "@/lib/api-helpers";
import { MAX_FILE_SIZE } from "@/lib/storage/types";
import { compressFailureMessage } from "./policy";
import { compressPdf, type PdfCompressLevel, type RunDeps } from "./run";

export interface FittedPdf {
  buffer: Buffer;
  /** 縮めたときだけ、圧縮前の大きさ(bytes)。縮めていなければ null。 */
  originalSize: number | null;
  level: PdfCompressLevel | null;
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
