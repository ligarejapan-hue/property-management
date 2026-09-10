/**
 * LP用写真の端末側前処理(設計 2026-09-08 §2.3)。
 *  - サーバーは JPEG/PNG/WebP・8MB以下・長辺1600px以下だけ受ける(画像ライブラリを入れない方針)。
 *  - ここで長辺1600に縮小し JPEG(品質0.85)へ再エンコードする。HEIC もここで吸収する。
 *  - canvas 経由で EXIF は消える(サーバーの EXIF strip と二重防御)。
 *  - PNG/WebP は無変換(pass)にしない(PNG の iTXt/tEXt・WebP の XMP など、EXIF 以外の
 *    付随情報が残り得るため)。無変換で通すのは JPEG だけにし、PNG/WebP は毎回 JPEG へ
 *    再エンコードして落とす(画面経由の登録のみ。API を直接叩けば残る=docs/deploy.md 参照)。
 *  - 判定と名前は純関数(node で検証)。browser API は prepare 本体だけが触る。
 *  - 画像内容・ファイル名を console に出さない。
 */
import { MAX_FILE_SIZE } from "@/lib/storage/types";
import { fitWithinMaxEdge } from "@/lib/field-survey-photo-prepare";

export const LP_ASSET_MAX_EDGE = 1600;
export const LP_ASSET_PASS_THROUGH_MIMES = ["image/jpeg"] as const;
const JPEG_QUALITY = 0.85;

export type LpAssetAction = "pass" | "convert" | "unsupported";

export function classifyLpAsset(input: { mime: string; width: number; height: number; size: number }): LpAssetAction {
  if (!input.mime.startsWith("image/")) return "unsupported";
  const passMime = (LP_ASSET_PASS_THROUGH_MIMES as readonly string[]).includes(input.mime);
  const fits = Math.max(input.width, input.height) <= LP_ASSET_MAX_EDGE && input.size <= MAX_FILE_SIZE;
  return passMime && fits ? "pass" : "convert";
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
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, message: DECODE_FAILED };
  }
  try {
    const action = classifyLpAsset({ mime: file.type, width: bitmap.width, height: bitmap.height, size: file.size });
    if (action === "unsupported") return { ok: false, message: UNSUPPORTED };
    if (action === "pass") return { ok: true, blob: file, fileName: lpAssetFileName(file.name, "pass") };
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
