// 印刷HTML(Plan 2 デザインテンプレ)の「追跡枠」に差し込む HTML 断片を組む純関数。
// qrSvg は本システム生成の信頼できる SVG(qrcode 出力)なのでそのまま埋め込む。
// url はテキスト表示分のみ HTML エスケープする(QR の中身=url は既に encodeURIComponent 済み)。

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface TrackingSlotOptions {
  /** QR の下に出す案内文(任意)。既定は無し。 */
  caption?: string;
}

/**
 * 追跡枠の HTML 断片(QR + 短縮URL テキスト)を返す。
 * Plan 2 の renderLetterHtml がデザインテンプレの slot へこの断片を差し込む。
 */
export function renderTrackingSlotHtml(
  artifacts: { url: string; qrSvg: string },
  opts: TrackingSlotOptions = {},
): string {
  const caption = opts.caption ? `<p class="sale-dm-track-caption">${escapeHtml(opts.caption)}</p>` : "";
  return [
    `<div class="sale-dm-tracking">`,
    `<div class="sale-dm-track-qr">${artifacts.qrSvg}</div>`,
    `<p class="sale-dm-track-url">${escapeHtml(artifacts.url)}</p>`,
    caption,
    `</div>`,
  ].join("");
}
