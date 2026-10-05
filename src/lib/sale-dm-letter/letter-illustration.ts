/**
 * 売却DMの手紙のイラスト(設計 2026-10-05)。純関数だけ=画面(見本)と印刷 route の両方から使う。
 * 本文の【イラスト】の行(行全体が印・前後の空白は可)で前後に分け、最初の印の位置にイラストを置く。
 * 印が無ければ本文の上。2つ目以降の印・イラストが無いときの印は、行ごと消す(紙に【イラスト】を出さない)。
 */
export type LetterIllustration = { src: string; width: number; height: number };

const MARKER_LINE = /^[ \t　]*【イラスト】[ \t　]*$/;
const PUBLIC_ID = /^[0-9a-f]{32}$/;
const SAFE_SRC = /^\/lp-assets\/[0-9a-f]{32}$/;

export function placeIllustration(body: string): { before: string; after: string; stripped: string; hasMarker: boolean } {
  const lines = body.split(/\r\n|\r|\n/);
  const first = lines.findIndex((l) => MARKER_LINE.test(l));
  const keep = (ls: string[]) => ls.filter((l) => !MARKER_LINE.test(l));
  const stripped = keep(lines).join("\n");
  if (first === -1) return { before: "", after: stripped, stripped, hasMarker: false };
  return {
    before: lines.slice(0, first).join("\n"),
    after: keep(lines.slice(first + 1)).join("\n"),
    stripped,
    hasMarker: true,
  };
}

export function isSafeIllustrationSrc(src: string): boolean {
  return SAFE_SRC.test(src);
}

/** 写真の行 → 描画用。未設定・削除済み・publicId が不正なら null(=イラスト無しで描く)。 */
export function letterIllustrationFromAsset(
  a: { publicId: string; width: number; height: number; deletedAt: Date | string | null } | null | undefined,
): LetterIllustration | null {
  if (!a || a.deletedAt) return null;
  if (!PUBLIC_ID.test(a.publicId)) return null;
  return { src: `/lp-assets/${a.publicId}`, width: a.width, height: a.height };
}
