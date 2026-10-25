/**
 * 書類を撮る — canvas の小道具(ブラウザ専用)。
 * ⚠縮めるときは縦横比を保つ(引き伸ばさない・切り落とさない)。
 * ⚠canvas から作った JPEG には EXIF(位置情報など)が付かない。
 */
import { fitWithinMaxEdge } from "@/lib/field-survey-photo-prepare";
import { quadBounds, type Quad } from "./geometry";

/** 画像・動画・canvas を、長い辺 maxEdge 以内(縦横比そのまま)の新しい canvas に描く。 */
export function drawScaled(
  source: CanvasImageSource,
  width: number,
  height: number,
  maxEdge: number,
): HTMLCanvasElement {
  const size = fitWithinMaxEdge(width, height, maxEdge);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas-unavailable");
  ctx.drawImage(source, 0, 0, size.width, size.height);
  return canvas;
}

/**
 * 部品(OpenCV.js)が読めなかったときの代わり: 四隅を囲む長方形で切り取る(形の直しはしない)。
 * 人が合わせた角を無視して写真全体を使わないための最低限。
 */
export function cropToQuadBounds(source: HTMLCanvasElement, quad: Quad, maxEdge: number): HTMLCanvasElement {
  const b = quadBounds(quad, source);
  const cropped = document.createElement("canvas");
  cropped.width = b.width;
  cropped.height = b.height;
  const ctx = cropped.getContext("2d");
  if (!ctx) throw new Error("canvas-unavailable");
  ctx.drawImage(source, b.x, b.y, b.width, b.height, 0, 0, b.width, b.height);
  return drawScaled(cropped, b.width, b.height, maxEdge);
}

export function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("encode-failed"))), "image/jpeg", quality);
  });
}
