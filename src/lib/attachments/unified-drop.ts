/**
 * 物件の画面のファイルを入れる枠を1つにする(2026-10-28 発注者決定)— 入れたファイルの行き先(純関数)。
 *   画像 → 写真か書類かを選ぶ(既定=写真・発注者決定)
 *   PDF  → 中身を見て(split-analyze)、まとめてあるなら分け方の確認・謄本なら謄本・ほかは通常の添付
 *   ほか → 通常の添付
 */
import { docKindByCode } from "@/lib/doc-classify/classify";
import { REGISTRY_KIND } from "@/lib/pdf-split/segments";

export type DropKind = "image" | "pdf" | "other";

const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif)$/i;

export function dropKindOf(file: { name: string; type: string }): DropKind {
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) return "pdf";
  if (file.type.startsWith("image/") || IMAGE_EXT.test(file.name)) return "image";
  return "other";
}

/** 画像(写真か書類かを聞く)と、それ以外(すぐ送る)に分ける。並びは入れた順のまま。 */
export function splitDrop<T extends { name: string; type: string }>(files: readonly T[]): { images: T[]; rest: T[] } {
  const images: T[] = [];
  const rest: T[] = [];
  for (const file of files) (dropKindOf(file) === "image" ? images : rest).push(file);
  return { images, rest };
}

/**
 * split=分け方の確認 / registry=謄本として保存 / general=通常の添付 /
 * ask=中身を確かめられなかった(謄本かもしれない)ので、謄本か通常の添付かを人に聞く。
 */
export type PdfRoute = "split" | "registry" | "general" | "ask";

/**
 * 分け方の案から、PDF をどう保存するかを決める。案が無い(中身を見られなかった)ときは null を渡す。
 * ⚠謄本を通常の添付で保存すると、謄本の守り(開ける人の絞り込み・名前を出さない)と面積の補完が効かない。
 *   見られなかった・文字の無いページを読み取れなかったときは推測せず聞く(@提出前レビュー P2)。
 */
export function routeForAnalysis(
  a: {
    pageCount: number | null;
    tooManyPages: boolean;
    ocr?: string;
    segments: readonly { from: number; to: number; kind: string | null }[];
  } | null,
): PdfRoute {
  if (a === null || a.pageCount === null || a.segments.length === 0) return "ask";
  if (a.tooManyPages) return "general";
  if (a.segments.length >= 2) return "split";
  if (a.segments[0].kind === REGISTRY_KIND) return "registry";
  return a.ocr === "unavailable" || a.ocr === "failed" ? "ask" : "general";
}

/** 分け方の画面に出す種類の名前。 */
export function segmentKindLabel(kind: string | null): string {
  if (kind === REGISTRY_KIND) return "謄本";
  return docKindByCode(kind)?.label ?? "その他";
}
