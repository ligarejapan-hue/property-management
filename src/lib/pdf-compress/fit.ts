/**
 * 添付の入口から使う: 目標(8MB)を超えた PDF を縮めて、保存してよい形にする。
 * 目標以下ならそのまま返す(手を触れない)。
 * 2026-10-19(発注者決定): 目標まで縮まなくても、保存してよい上限(20MB)以下なら保存する。
 *   縮んだ形が上限以下ならそれを、縮まない(圧縮できない・元より小さくならない)ときは元のまま。
 *   上限を超えたままのときだけ 422 で理由を返す。
 */
import { ApiError } from "@/lib/api-helpers";
import { MAX_FILE_SIZE } from "@/lib/storage/types";
import { compressBusyMessage, compressFailureMessage, MAX_ATTACHMENT_BYTES } from "./policy";
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
 * 圧縮(または大きいPDFの読み取り)が要るかもしれない大きさの送信なら、**本文を読む前に**席を取る。
 * 取れなければ 503(いま別の大きいPDFを処理中)。返した関数は finally で必ず呼ぶ。
 * ⚠基準は「送信全体が上限(8MB)を超えるか」。上乗せ分(multipart の境界など)を引いて
 *   考えると、8.1〜8.9MB の PDF が席を取らずに圧縮へ進めてしまう(@codex PR#498 2巡目)。
 *   ファイルが上限を超えるなら送信全体も必ず上限を超えるので、こちらで漏れは無い。
 */
export function reserveLargePdfSlot(
  request: { headers: { get(name: string): string | null } },
  reserve: () => (() => void) | null = tryReserveCompressionSlot,
): () => void {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (!Number.isFinite(declared) || declared <= MAX_FILE_SIZE) return NO_OP;
  const release = reserve();
  if (release === null) throw new ApiError(503, compressBusyMessage(), "BUSY");
  return release;
}

export async function fitPdfToLimit(
  buffer: Buffer,
  opts: { limitBytes?: number; acceptBytes?: number; deps?: RunDeps } = {},
): Promise<FittedPdf> {
  const limitBytes = opts.limitBytes ?? MAX_FILE_SIZE;
  const acceptBytes = Math.max(opts.acceptBytes ?? MAX_ATTACHMENT_BYTES, limitBytes);
  const asIs: FittedPdf = { buffer, originalSize: null, level: null };
  if (buffer.length <= limitBytes) return asIs;
  const r = await compressPdf(buffer, limitBytes, opts.deps, acceptBytes);
  if (r.ok) {
    // 縮んでいなければ圧縮したことにしない(元のまま)。
    if (r.buffer.length >= buffer.length && buffer.length <= acceptBytes) return asIs;
    return { buffer: r.buffer, originalSize: r.inBytes, level: r.level };
  }
  // 縮められなくても、元が保存してよい上限以下なら元のまま保存する。
  if (buffer.length <= acceptBytes) return asIs;
  throw new ApiError(
    422,
    compressFailureMessage(r.reason, { inBytes: r.inBytes, bestBytes: r.bestBytes, limitBytes: acceptBytes }),
    "VALIDATION_ERROR",
  );
}
