import type { SaleDmCampaign } from "@/lib/api-client";
import { isInquiry } from "./recipient-actions";

export function formatRate(numerator: number, denominator: number): string {
  if (denominator <= 0) return "—";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

export interface VariantRow {
  variantId: string;
  label: string;
  sent: number;          // 送付数(= その型に割当たった宛先数)
  delivered: number;     // 到達数(deliveryStatus=delivered)
  undeliverable: number; // 宛先不明数(deliveryStatus=returned_undeliverable)
  inquiries: number;     // 反響数(LP∪電話・総数)
  inquiryRate: string;   // 到達かつ反響 / 到達(>100%にしないため分子は到達者に限定)
  undeliverableRate: string; // 宛先不明 / 送付
}

// 集計の母数: 反響率=到達数 / 宛先不明率=送付数(設計書の定義に一致)。
export function buildVariantRows(campaign: SaleDmCampaign): VariantRow[] {
  return campaign.variants.map((v) => {
    const drafts = campaign.recipients.filter((r) => r.variantId === v.id);
    const sent = drafts.length;
    const delivered = drafts.filter((r) => r.deliveryStatus === "delivered").length;
    const undeliverable = drafts.filter((r) => r.deliveryStatus === "returned_undeliverable").length;
    const inquiries = drafts.filter((r) => isInquiry(r)).length;
    // 反響率の分子は「到達かつ反響」(サーバ集計 aggregate.ts と同義)。未到達(returned 等)の
    // 反響を分子に入れると率が100%を超え得るため除外する。inquiries(総数)は表示用に保持。
    const deliveredInquiries = drafts.filter((r) => r.deliveryStatus === "delivered" && isInquiry(r)).length;
    return {
      variantId: v.id,
      label: v.label,
      sent,
      delivered,
      undeliverable,
      inquiries,
      inquiryRate: formatRate(deliveredInquiries, delivered),
      undeliverableRate: formatRate(undeliverable, sent),
    };
  });
}
