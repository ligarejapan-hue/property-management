// 配信停止QRの紙面断片。既存テンプレの追跡枠(trackingSlotHtml)へ**連結**して差し込む
// (テンプレ本体・型は変更しない)。qrSvg は本システム生成の信頼できる SVG(qrcode 出力)。
// url はテキスト表示分のみ HTML エスケープする(tracking-slot.ts と同じ流儀)。

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 停止枠の HTML 断片(小さめQR + URL + 案内文)。
 * 無料査定QR(追跡枠)と紛れないよう、専用クラス+控えめな見た目にする。
 * スタイルはインライン(テンプレの <style> を触らないため)。
 */
export function renderUnsubscribeSlotHtml(artifacts: {
  url: string;
  qrSvg: string;
}): string {
  return [
    `<div class="sale-dm-unsubscribe" style="margin-top:4mm;padding-top:3mm;border-top:1px solid #ddd;display:flex;align-items:center;gap:4mm;justify-content:center">`,
    // QR は追跡枠より一回り小さく(主役は査定QR。停止は選べる導線として明示)。
    `<div class="sale-dm-unsub-qr" style="width:14mm;height:14mm;flex:none">${artifacts.qrSvg}</div>`,
    `<div style="text-align:left;font-size:7.5pt;color:#777;line-height:1.6">`,
    `<p style="margin:0">今後このようなお手紙が不要な場合は、こちらのQRコードからお申し出いただけます(配信停止)。</p>`,
    `<p class="sale-dm-unsub-url" style="margin:0;word-break:break-all">${escapeHtml(artifacts.url)}</p>`,
    `</div>`,
    `</div>`,
  ].join("");
}
