import { sniffImage } from "@/lib/doc-scan/upload";
import { stripFieldSurveyPhotoMetadata } from "@/lib/field-survey/exif-strip";
import { readImageDimensions } from "@/lib/image-dimensions";
import { stripLpAssetMetadata } from "@/lib/lp-asset-metadata-strip";
import { isPdfBuffer } from "@/lib/pdf-extract";
import { DOC_FILE_MAX_BYTES } from "./constants";

export type InspectedFile = { ok: true; buffer: Buffer; mimeType: string; ext: string } | { ok: false; reason: "too_large" | "unsupported" | "malformed" };

const IMAGE_MIME = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" } as const;
const IMAGE_EXT = { jpeg: "jpg", png: "png", webp: "webp" } as const;

/**
 * 保存してよいファイルかを、送られてきた中身だけで決める(申告の種類・ファイル名・端末側の処理は信じない)。
 * 画像は EXIF を除いたうえで、デコードに要らないバイトを許可リストで全部落とす。読み切れない画像は保存しない(元のまま通さない)。
 * ⚠向きの情報も落ちる。お客様のページは画像をすべて canvas で描き直して向きを画素に焼き込んでから送る。
 * PDF は種類と大きさだけを見て、そのまま保存する。社内ではダウンロードでしか渡さない。
 */
export function inspectSubmittedFile(raw: Buffer): InspectedFile {
  if (raw.length === 0) return { ok: false, reason: "unsupported" };
  if (raw.length > DOC_FILE_MAX_BYTES) return { ok: false, reason: "too_large" };
  if (isPdfBuffer(raw)) return { ok: true, buffer: raw, mimeType: "application/pdf", ext: "pdf" };
  const kind = sniffImage(raw);
  if (!kind) return { ok: false, reason: "unsupported" };
  const mimeType = IMAGE_MIME[kind];
  const stripped = stripFieldSurveyPhotoMetadata(raw, mimeType);
  if (!stripped.ok) return { ok: false, reason: "malformed" };
  const lean = stripLpAssetMetadata(stripped.buffer, mimeType);
  if (!lean.ok) return { ok: false, reason: "malformed" };
  if (lean.buffer.length > DOC_FILE_MAX_BYTES) return { ok: false, reason: "too_large" };
  if (!readImageDimensions(lean.buffer, mimeType)) return { ok: false, reason: "malformed" };
  return { ok: true, buffer: lean.buffer, mimeType, ext: IMAGE_EXT[kind] };
}
