// 配信停止QRの紙面断片。紙面テンプレの問い合わせ枠の下の小さな行(unsubscribeSlotHtml)へ差し込む。
// qrSvg は本システム生成の信頼できる SVG(qrcode 出力)。
// url はテキスト表示分のみ HTML エスケープする(tracking-slot.ts と同じ流儀)。
// 見た目(QR の大きさ・字の大きさ)は紙面テンプレ側の CSS で決める(ここは構造だけ)。

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 停止枠の HTML 断片(小さめQR + 案内文 + URL)。
 * 無料査定QR(追跡枠)と紛れないよう、専用クラスを持つ(大きさはテンプレで一回り小さく)。
 */
export function renderUnsubscribeSlotHtml(artifacts: {
  url: string;
  qrSvg: string;
}): string {
  return [
    // qrcode の SVG は viewBox のみで width/height を持たない。枠だけ絞っても
    // 中の SVG は既定の内在サイズで溢れ得るため、SVG 自体を枠へ追従させる(@codex #416 R2 P2)。
    `<style>.sale-dm-unsub-qr svg{width:100%;height:100%;display:block}</style>`,
    `<div class="sale-dm-unsubscribe">`,
    `<div class="sale-dm-unsub-qr">${artifacts.qrSvg}</div>`,
    `<div class="sale-dm-unsub-text">`,
    `<p>今後このようなお手紙が不要な方は、左のQRコードからお申し出ください（配信停止）。</p>`,
    `<p class="sale-dm-unsub-url">${escapeHtml(artifacts.url)}</p>`,
    `</div>`,
    `</div>`,
  ].join("");
}
