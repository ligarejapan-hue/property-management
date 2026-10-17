// 印刷HTML(紙面テンプレ)の「追跡枠」=問い合わせ枠の右側(無料査定QR)に差し込む HTML 断片を組む純関数。
// qrSvg は本システム生成の信頼できる SVG(qrcode 出力)なのでそのまま埋め込む。
// url はテキスト表示分のみ HTML エスケープする(QR の中身=url は既に encodeURIComponent 済み)。
// 見た目(QR の大きさ・字の大きさ)は紙面テンプレ側の CSS で決める(ここは構造だけ)。

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface TrackingSlotOptions {
  /** QR の横に出す案内文(任意)。既定は無し。 */
  caption?: string;
  /** 案内文の下の添え書き(任意)。既定は無し。 */
  hint?: string;
}

/**
 * 追跡枠の HTML 断片(QR + 案内文 + 短縮URL テキスト)を返す。
 * 紙面テンプレ(renderLetterHtml)が問い合わせ枠の slot へこの断片を差し込む。
 */
export function renderTrackingSlotHtml(
  artifacts: { url: string; qrSvg: string },
  opts: TrackingSlotOptions = {},
): string {
  const caption = opts.caption ? `<p class="sale-dm-track-caption">${escapeHtml(opts.caption)}</p>` : "";
  const hint = opts.hint ? `<p class="sale-dm-track-hint">${escapeHtml(opts.hint)}</p>` : "";
  return [
    `<div class="sale-dm-tracking">`,
    `<div class="sale-dm-track-qr">${artifacts.qrSvg}</div>`,
    `<div class="sale-dm-track-text">`,
    caption,
    hint,
    `<p class="sale-dm-track-url">${escapeHtml(artifacts.url)}</p>`,
    `</div>`,
    `</div>`,
  ].join("");
}
