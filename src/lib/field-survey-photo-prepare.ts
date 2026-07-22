/**
 * 調査ピン写真の端末内自動変換 (HEIC / 大容量対策)。
 *
 * 背景:
 * - iPhone 既定の高効率 (HEIC/HEIF) 形式はサーバー側 EXIF strip 未対応のため
 *   422 で拒否される (ギャラリー選択で混入し得る。カメラ直起動は通常 JPEG)。
 * - 写真は 8MB (MAX_FILE_SIZE) 上限で、最近のスマホの原寸写真は超過し得る。
 *
 * 対応: アップロード前に端末内で JPEG へ変換・縮小して吸収する。
 * - 上限内の JPEG/PNG/WebP は無変換で通す (画質無劣化)
 * - それ以外は decode → canvas → JPEG 再エンコード (長辺・画質を段階的に縮小)
 * - decode できない端末 (例: Android Chrome は HEIC を decode 不可) では
 *   平易な日本語で各端末のカメラ設定 (iPhone=互換性優先 / Android=HEIF オフ)
 *   へ誘導する
 *
 * 注意:
 * - canvas 再エンコードで EXIF は全て消える (GPS 含む)。サーバー側の
 *   EXIF/GPS strip (fail-closed) はそのまま維持され、二重防御になる。
 * - 判定・寸法計算・文言は純関数に分離し node (vitest) で検証する。
 *   browser API (createImageBitmap / canvas) は prepare 本体のみが触り、
 *   存在ガード付きで node import してもクラッシュしない。
 * - 画像内容・ファイル名・寸法を console に出さない。
 */

import { MAX_FILE_SIZE } from "@/lib/storage/types";

/** 無変換で通す形式 (サーバーの EXIF strip が対応している形式)。 */
export const PHOTO_PASS_THROUGH_MIMES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

/** 変換の試行ラダー (長辺 px / JPEG 画質)。上から順に試し 8MB 以下で採用。 */
export const PHOTO_CONVERT_ATTEMPTS = [
  { maxEdge: 2560, quality: 0.85 },
  { maxEdge: 2048, quality: 0.8 },
  { maxEdge: 1600, quality: 0.7 },
] as const;

/** 縮小しても上限に収まらなかった時の文言。 */
export const PHOTO_TOO_LARGE_MESSAGE =
  "写真を縮小しても保存できる大きさになりませんでした。別の写真をお試しください。";

/** アップロード前の扱い: そのまま送る (pass) / 端末内で変換する (convert)。 */
export function classifyPhotoForUpload(input: {
  mimeType: string;
  size: number;
}): "pass" | "convert" {
  const type = (input.mimeType || "").toLowerCase();
  if (!(PHOTO_PASS_THROUGH_MIMES as readonly string[]).includes(type)) {
    return "convert";
  }
  if (input.size > MAX_FILE_SIZE) return "convert";
  return "pass";
}

/**
 * アスペクト比を維持して長辺を maxEdge 以下に収める (拡大はしない)。
 * 不正値 (0 / 負 / 非有限) は 1px に倒して canvas 例外を避ける。
 */
export function fitWithinMaxEdge(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const w = Number.isFinite(width) && width > 0 ? width : 1;
  const h = Number.isFinite(height) && height > 0 ? height : 1;
  const longEdge = Math.max(w, h);
  if (longEdge <= maxEdge) {
    return { width: Math.round(w), height: Math.round(h) };
  }
  const scale = maxEdge / longEdge;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

/** 変換後のファイル名 (拡張子を .jpg に差し替え)。 */
export function convertedPhotoFileName(name: string): string {
  const base = (name || "").replace(/\.[^.]*$/, "");
  return `${base || "photo"}.jpg`;
}

/**
 * decode 失敗時の案内文言。HEIC/HEIF とわかる場合は iPhone の
 * 「互換性優先」設定へ誘導する (技術用語は使わない)。
 */
export function photoPrepareFailureMessage(input: {
  mimeType: string;
  fileName: string;
}): string {
  const t = (input.mimeType || "").toLowerCase();
  const n = (input.fileName || "").toLowerCase();
  if (
    t.includes("heic") ||
    t.includes("heif") ||
    n.endsWith(".heic") ||
    n.endsWith(".heif")
  ) {
    // HEIF は Android (Samsung 等) のカメラでも生成されるため端末中立に案内する。
    return "この写真 (高効率/HEIC・HEIF形式) はこの端末では変換できませんでした。iPhoneは「設定 → カメラ → フォーマット」を「互換性優先」に、Androidはカメラ設定の高効率 (HEIF) をオフにして撮影した写真をお使いください。";
  }
  return "この写真は読み込めませんでした。JPEG/PNG形式の写真をお使いください。";
}

export type PreparedPhoto =
  | { ok: true; file: File; converted: boolean }
  | { ok: false; error: string };

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

/**
 * アップロード前の写真準備。pass はそのまま返し、convert 対象は JPEG へ
 * 変換・縮小する。失敗時は平易な案内文言を返す (呼び出し側がエラー表示)。
 */
export async function prepareFieldSurveyPhotoForUpload(
  file: File,
): Promise<PreparedPhoto> {
  if (
    classifyPhotoForUpload({ mimeType: file.type, size: file.size }) === "pass"
  ) {
    return { ok: true, file, converted: false };
  }
  const decoded = await decodeImage(file);
  if (!decoded) {
    return {
      ok: false,
      error: photoPrepareFailureMessage({
        mimeType: file.type,
        fileName: file.name,
      }),
    };
  }
  try {
    // 「サイズ超過」と「環境起因の生成失敗 (getContext/toBlob が null)」を
    // 区別する。一度も Blob を作れなかった場合にサイズ起因の文言を出すと
    // 誤帰属になる (実際はサイズ判定に到達していない)。
    let producedBlob = false;
    for (const attempt of PHOTO_CONVERT_ATTEMPTS) {
      const blob = await renderToJpegBlob(decoded, attempt);
      if (!blob) continue;
      producedBlob = true;
      if (blob.size <= MAX_FILE_SIZE) {
        return {
          ok: true,
          file: new File([blob], convertedPhotoFileName(file.name), {
            type: "image/jpeg",
          }),
          converted: true,
        };
      }
    }
    return {
      ok: false,
      error: producedBlob
        ? PHOTO_TOO_LARGE_MESSAGE
        : photoPrepareFailureMessage({
            mimeType: file.type,
            fileName: file.name,
          }),
    };
  } catch {
    return {
      ok: false,
      error: photoPrepareFailureMessage({
        mimeType: file.type,
        fileName: file.name,
      }),
    };
  } finally {
    decoded.release();
  }
}

/**
 * browser の画像 decode。createImageBitmap 優先 (EXIF の向きを反映)、
 * 使えない環境は <img> decode にフォールバック。どちらも不可なら null。
 */
async function decodeImage(file: File): Promise<DecodedImage | null> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close(),
      };
    } catch {
      // fall through (<img> フォールバックへ)
    }
  }
  if (
    typeof document === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    return null;
  }
  const url = URL.createObjectURL(file);
  try {
    const img = document.createElement("img");
    img.decoding = "async";
    img.src = url;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) {
      URL.revokeObjectURL(url);
      return null;
    }
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    };
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
}

/** canvas へ縮小描画して JPEG Blob を作る。作れない環境は null。 */
async function renderToJpegBlob(
  decoded: DecodedImage,
  attempt: { maxEdge: number; quality: number },
): Promise<Blob | null> {
  if (typeof document === "undefined") return null;
  const { width, height } = fitWithinMaxEdge(
    decoded.width,
    decoded.height,
    attempt.maxEdge,
  );
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // PNG 等の透過は JPEG で黒くなるため白で敷く。
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(decoded.source, 0, 0, width, height);
  return await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/jpeg", attempt.quality);
  });
}
