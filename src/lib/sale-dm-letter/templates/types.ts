// 1通の手紙を HTML 断片へ流し込むための入力。すべて呼び出し側(route)が
// DmRecipientDraft + DmVariant + 差出人設定から組み立てる。PII(body/宛名/住所)を含むため
// レンダラ側で必ず escapeHtml を通してから埋め込む。
export interface LetterRenderInput {
  designTemplate: string; // "formal" | "soft" | "impact"(未知値は formal にフォールバック)
  body: string; // AI 生成 or 手直し済みの本文(改行を含む)
  addresseeName: string; // 代表者名(生値)
  honorific: string; // "様" / "御中" / "様 他共有者様" 等
  recipientZip: string | null;
  recipientAddress: string | null;
  senderName: string;
  senderContact: string;
  trackingToken: string; // 宛先固有の opaque トークン(slot の data 属性に出す)。
  // 追跡枠に差し込む HTML 断片(renderTrackingSlotHtml の出力=QR+短縮URL)。
  // 呼び出し側(印刷route)が確定済み draft から生成して渡す。未指定なら枠は空。
  trackingSlotHtml?: string;
}
