/**
 * qr-code.ts — QR コード生成（qrcode-generator・依存ゼロライブラリ）
 *
 * エディタ（ブラウザ）と vitest（node）の両方で動く純関数。
 * 生成物は GIF の data URL（data:image/gif;base64,…）。qr 要素 schema の
 * dataUrl 検証（data:image/ 始まり）と、保存境界の個別 data: 上限
 * （design-service.ts の MAX_INLINE_IMAGE_SRC_LEN=8192 と同値）に収まる
 * ことを生成時に保証する。
 */
import qrcode from "qrcode-generator";

/** 保存境界 design-service.ts の MAX_INLINE_IMAGE_SRC_LEN と同値（独立定義）。 */
const MAX_QR_DATA_URL_LEN = 8192;

/** QR 1 セルの描画ピクセルと余白。30mm 枠への拡大とデータ量のバランス。 */
const CELL_SIZE_PX = 4;
const MARGIN_PX = 16;

/** printable ASCII のみ許可。qrcode-generator の既定 Byte モードは非 ASCII を
 *  文字化けさせる（UTF-8 変換を持たない）ため、URL 等の半角に限定する。 */
const ASCII_ONLY = /^[\x20-\x7e]+$/;

/**
 * テキスト → QR コードの data URL。
 * null を返すケース（呼び出し側は no-op にする）:
 * - 空・空白のみ / 非 ASCII を含む
 * - 容量超過（qrcode-generator が throw）
 * - 生成結果が保存境界の data: 上限を超える
 * 決定的: 同一入力から常に同一出力。
 */
export function generateQrDataUrl(content: string): string | null {
  const text = content.trim();
  if (text === "" || !ASCII_ONLY.test(text)) return null;
  try {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const dataUrl = qr.createDataURL(CELL_SIZE_PX, MARGIN_PX);
    if (!dataUrl.startsWith("data:image/") || dataUrl.length > MAX_QR_DATA_URL_LEN) {
      return null;
    }
    return dataUrl;
  } catch {
    return null;
  }
}
