/**
 * 「ファイルを入れる」の表の文言(純関数)。
 */
import { MAX_ATTACHMENT_BYTES, MAX_PDF_UPLOAD_BYTES } from "@/lib/pdf-compress/policy";
import { dropFileKind } from "./detect";

/**
 * 表に出す名前。⚠PDF は謄本かもしれない(ファイル名に所有者名が入り得る)ので、名前を出さず何件目かだけ
 * (物件の画面の添付と同じ決まり)。
 */
export function dropRowName(file: { name: string; type: string }, index: number): string {
  return dropFileKind(file) === "pdf" ? `${index + 1}件目のPDF` : file.name;
}

function mb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}

/** 受け取り箱に入れられない大きさなら理由(PDF は 50MB・ほかは 20MB まで=受け取り箱と同じ)。 */
export function inboxSizeError(file: { name: string; type: string; size: number }): string | null {
  const limit = dropFileKind(file) === "pdf" ? MAX_PDF_UPLOAD_BYTES : MAX_ATTACHMENT_BYTES;
  if (file.size <= 0) return "空のファイルは入れられません";
  return file.size > limit ? `大きすぎます(${mb(limit)}まで)` : null;
}

/** 受け取り箱に入れられなかった理由。使えない人(403)には決まった案内(発注者決定)。 */
export function inboxErrorMessage(e: unknown): string {
  const status = (e as { status?: unknown } | null)?.status;
  if (status === 403) {
    return "この書類は受け取り箱に入れられません(所有者情報をすべて見られる方だけが使えます)";
  }
  return e instanceof Error ? e.message : "受け取り箱に入れられませんでした";
}
