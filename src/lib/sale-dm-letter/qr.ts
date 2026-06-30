import QRCode from "qrcode";
import { buildTrackingUrl } from "./tracking";

/**
 * 追跡URLの QR を SVG マークアップ文字列で生成する(サーバー側・ブラウザ非依存)。
 * SVG はサイズ非依存で印刷に鮮明・HTML へインライン埋め込み可能。
 * `margin: 1` で印刷余白を最小化、`errorCorrectionLevel: "M"` で実用バランス。
 */
export async function buildTrackingQrSvg(url: string): Promise<string> {
  return QRCode.toString(url, {
    type: "svg",
    margin: 1,
    errorCorrectionLevel: "M",
  });
}

/**
 * テンプレ(Plan 2 renderLetterHtml)の追跡枠 slot 用に、追跡URL と QR(SVG)を
 * まとめて生成する。URL/QR とも opaque token のみで PII を含まない。
 */
export async function buildTrackingArtifacts(
  token: string,
  baseUrl?: string,
): Promise<{ url: string; qrSvg: string }> {
  const url = buildTrackingUrl(token, baseUrl);
  const qrSvg = await buildTrackingQrSvg(url);
  return { url, qrSvg };
}
