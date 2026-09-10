/**
 * LP用写真の端末側前処理(設計 2026-09-08 §2.3)。
 *  - サーバーは JPEG/PNG/WebP・8MB以下・長辺1600px以下だけ受ける(画像ライブラリを入れない方針)。
 *  - **例外なく全ての画像**を canvas で再エンコードする(長辺1600に縮小し JPEG 品質0.85)。
 *    HEIC もここで吸収する。無変換で送る道(pass)は用意しない。
 *  - 無変換を廃した理由:
 *      (1) サーバー側の許可リスト strip(src/lib/lp-asset-metadata-strip.ts)は
 *          **Orientation の APP1 も含めて付随情報を全て落とす**(docs/deploy.md)。
 *          無変換で送ると回転情報だけが失われ、写真が横倒しで公開されてしまう。
 *      (2) PNG の iTXt/tEXt・WebP の XMP など EXIF 以外の付随情報も、端末側で落としておきたい。
 *    そこで createImageBitmap に `{ imageOrientation: "from-image" }` を明示して
 *    **向きを画素そのものに焼き込んでから**送る(Chromium/WebKit の既定も from-image だが、
 *    実装依存にせず明示する)。
 *  - canvas を通すので EXIF は消える(サーバーの strip と二重防御)。
 *  - 判定と名前は純関数(node で検証)。browser API は prepare 本体だけが触る。
 *  - 画像内容・ファイル名を console に出さない。
 */
import { MAX_FILE_SIZE } from "@/lib/storage/types";
import { fitWithinMaxEdge } from "@/lib/field-survey-photo-prepare";

export const LP_ASSET_MAX_EDGE = 1600;
const JPEG_QUALITY = 0.85;

export type LpAssetAction = "convert" | "unsupported";

/**
 * 画像なら必ず "convert"(向きを焼き込むため無変換の道は無い)、それ以外は "unsupported"。
 * width/height/size は呼び出し側の記録用に受けるが、判定には使わない。
 */
export function classifyLpAsset(input: { mime: string; width: number; height: number; size: number }): LpAssetAction {
  return input.mime.startsWith("image/") ? "convert" : "unsupported";
}

export function lpAssetFileName(name: string, action: LpAssetAction): string {
  if (action !== "convert") return name;
  const base = name.replace(/\.[^.]+$/, "");
  return `${base || "image"}.jpg`;
}

export type PreparedLpAsset = { ok: true; blob: Blob; fileName: string } | { ok: false; message: string };

const UNSUPPORTED = "画像ファイル(JPEG / PNG / WebP / HEIC)を選んでください";
const DECODE_FAILED = "この画像はこの端末では読み込めませんでした。iPhone は「設定 > カメラ > フォーマット > 互換性優先」、Android は HEIF をオフにして撮り直すか、JPEG に変換してからお試しください";

export async function prepareLpAssetForUpload(file: File): Promise<PreparedLpAsset> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") {
    return { ok: false, message: "この端末では画像を処理できません" };
  }
  if (!file.type.startsWith("image/")) return { ok: false, message: UNSUPPORTED };
  let bitmap: ImageBitmap;
  try {
    // EXIF の向きを画素に反映させた bitmap を得る(明示しないと実装依存になる)。
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return { ok: false, message: DECODE_FAILED };
  }
  try {
    const action = classifyLpAsset({ mime: file.type, width: bitmap.width, height: bitmap.height, size: file.size });
    if (action === "unsupported") return { ok: false, message: UNSUPPORTED };
    const { width, height } = fitWithinMaxEdge(bitmap.width, bitmap.height, LP_ASSET_MAX_EDGE);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { ok: false, message: "この端末では画像を処理できません" };
    // PNG 等の透過は JPEG で黒くなるため白で敷く。
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
    if (!blob) return { ok: false, message: "画像の変換に失敗しました" };
    if (blob.size > MAX_FILE_SIZE) return { ok: false, message: "縮小しても 8MB を超えます。別の写真をお試しください" };
    return { ok: true, blob, fileName: lpAssetFileName(file.name, "convert") };
  } finally {
    bitmap.close?.();
  }
}
