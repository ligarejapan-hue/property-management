/**
 * 書類を撮る — OpenCV.js で紙の四隅を見つけ、正面から見た形に直す(ブラウザ専用)。
 *
 * ⚠OpenCV の Mat は JS のごみ集めで消えない。作ったものは必ず finally で delete する
 *   (撮影中は 1 秒に数回呼ぶので、漏れるとすぐにスマホのメモリが尽きる)。
 * 点の並べ替え・使えるかの判定・大きさの計算は geometry.ts(純関数・テストあり)。
 */
import type { CV } from "./opencv-loader";
import { isUsableQuad, orderCorners, warpedSize, type Quad } from "./geometry";

/** 仕上がり。clean=白地に黒い文字へ寄せる(影・色むらを消す)/color=色はそのまま。 */
export type ScanFinish = "clean" | "color";

/** 直したあとの長い辺の上限(px)。A4 で約 170dpi=文字の読み取りに足りる。 */
export const SCAN_MAX_EDGE = 2000;

/** canvas に描かれた画像から紙の四隅を探す。見つからなければ null。 */
export function detectQuad(cv: CV, canvas: HTMLCanvasElement): Quad | null {
  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  const edges = new cv.Mat();
  const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    cv.Canny(gray, edges, 50, 150);
    // 紙のふちの線が途切れていても1本につながるよう、少し太らせる。
    cv.dilate(edges, edges, kernel);
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const frame = { width: canvas.width, height: canvas.height };
    let best: { quad: Quad; area: number } | null = null;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const approx = new cv.Mat();
      try {
        const area = cv.contourArea(c);
        if (best && area <= best.area) continue;
        cv.approxPolyDP(c, approx, 0.02 * cv.arcLength(c, true), true);
        if (approx.rows !== 4) continue;
        const d = approx.data32S as Int32Array;
        const quad = orderCorners([
          { x: d[0], y: d[1] },
          { x: d[2], y: d[3] },
          { x: d[4], y: d[5] },
          { x: d[6], y: d[7] },
        ]);
        if (quad && isUsableQuad(quad, frame)) best = { quad, area };
      } finally {
        approx.delete();
        c.delete();
      }
    }
    return best?.quad ?? null;
  } finally {
    src.delete();
    gray.delete();
    edges.delete();
    kernel.delete();
    contours.delete();
    hierarchy.delete();
  }
}

/**
 * 四隅の内側を、正面から見た形(紙そのものの縦横比)に直して新しい canvas に描く。
 * 元の canvas には手を触れない。
 */
export function warpDocument(cv: CV, source: HTMLCanvasElement, quad: Quad, finish: ScanFinish): HTMLCanvasElement {
  const size = warpedSize(quad, SCAN_MAX_EDGE);
  const src = cv.imread(source);
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, quad.flatMap((p) => [p.x, p.y]));
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, size.width, 0, size.width, size.height, 0, size.height]);
  const matrix = cv.getPerspectiveTransform(from, to);
  const warped = new cv.Mat();
  const gray = new cv.Mat();
  const background = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9));
  try {
    cv.warpPerspective(src, warped, matrix, new cv.Size(size.width, size.height), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
    const out = document.createElement("canvas");
    if (finish === "color") {
      cv.imshow(out, warped);
      return out;
    }
    // 読みやすく: 文字を消した「紙の地」を作り、その差を取る=影と色むらが消えて白地に黒い文字になる。
    cv.cvtColor(warped, gray, cv.COLOR_RGBA2GRAY);
    cv.dilate(gray, background, kernel);
    cv.medianBlur(background, background, 21);
    cv.absdiff(gray, background, gray);
    cv.bitwise_not(gray, gray);
    cv.normalize(gray, gray, 0, 255, cv.NORM_MINMAX);
    cv.imshow(out, gray);
    return out;
  } finally {
    src.delete();
    from.delete();
    to.delete();
    matrix.delete();
    warped.delete();
    gray.delete();
    background.delete();
    kernel.delete();
  }
}
