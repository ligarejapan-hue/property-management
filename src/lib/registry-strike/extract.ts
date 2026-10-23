/**
 * 謄本PDFから「行ごとの文字＋下線（抹消）の印」を読み出す。サーバー専用。
 *
 * pdfjs-dist（pdf-parse が内部で使っているものと同じ版）で、文字の位置と
 * 図形の水平線を読み、`buildStrikeLines` で組み立てる。仕組みは `lines.ts` を参照。
 *
 * ⚠ 失敗しても取込を止めない設計にする（呼び出し側で null 扱い）。
 *   ここで読めなくても、従来の文字抽出（pdf-parse）による取込はそのまま動く。
 * ⚠ 本文・氏名・住所をログに出さない。
 */
import { buildStrikeLines, type StrikeLine, type StrikeSegment, type StrikeTextItem } from "./lines";

/** 読むページの上限（全部事項でも通常は数ページ。異常に大きいPDFで時間を使わない）。 */
const MAX_PAGES = 30;

export async function extractStrikeLinesFromPdf(buffer: Buffer): Promise<StrikeLine[]> {
  // dynamic import で webpack バンドルを回避（next.config.ts の serverExternalPackages に登録済み）
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const OPS = pdfjs.OPS;
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    verbosity: 0,
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise;

  try {
    const lines: StrikeLine[] = [];
    const pages = Math.min(doc.numPages, MAX_PAGES);
    for (let pageNo = 1; pageNo <= pages; pageNo++) {
      const page = await doc.getPage(pageNo);

      const segments: StrikeSegment[] = [];
      const ops = await page.getOperatorList();
      // 図形の座標は「現在の変換行列（CTM）」の中で書かれる。save/restore/transform を追って
      // 文字と同じページ座標へ直す（実物は単位行列だが、念のため）。
      let ctm: Matrix = [1, 0, 0, 1, 0, 0];
      const stack: Matrix[] = [];
      for (let k = 0; k < ops.fnArray.length; k++) {
        const fn = ops.fnArray[k];
        const args = ops.argsArray[k] as unknown[];
        if (fn === OPS.save) {
          stack.push(ctm);
        } else if (fn === OPS.restore) {
          ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
        } else if (fn === OPS.transform) {
          ctm = multiply(ctm, args as unknown as Matrix);
        } else if (fn === OPS.constructPath) {
          // pdfjs v5: args = [op, [pathData], minMax]。minMax = [minX, minY, maxX, maxY]
          const minMax = args?.[2] as ArrayLike<number> | null | undefined;
          if (!minMax || minMax.length < 4) continue;
          const [ax, ay] = apply(ctm, minMax[0], minMax[1]);
          const [bx, by] = apply(ctm, minMax[2], minMax[3]);
          // 水平線だけを拾う（高さがほぼ 0、幅がある）
          if (Math.abs(by - ay) > 0.5 || Math.abs(bx - ax) < 1) continue;
          segments.push({ x1: Math.min(ax, bx), x2: Math.max(ax, bx), y: (ay + by) / 2 });
        }
      }

      const content = await page.getTextContent();
      const items: StrikeTextItem[] = [];
      for (const it of content.items) {
        if (!("str" in it) || !it.str) continue;
        const t = it.transform as number[];
        items.push({
          str: it.str,
          x: t[4],
          y: t[5],
          width: it.width,
          fontSize: Math.abs(t[3]) || Math.abs(t[0]) || 1,
        });
      }

      lines.push(...buildStrikeLines(pageNo, items, segments));
      page.cleanup();
    }
    return lines;
  } finally {
    await doc.destroy();
  }
}

type Matrix = [number, number, number, number, number, number];

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}
