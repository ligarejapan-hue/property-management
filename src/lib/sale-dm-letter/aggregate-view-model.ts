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
  inquiries: number;     // 反響数(LP∪電話)
  inquiryRate: string;   // 反響 / 到達
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
    return {
      variantId: v.id,
      label: v.label,
      sent,
      delivered,
      undeliverable,
      inquiries,
      inquiryRate: formatRate(inquiries, delivered),
      undeliverableRate: formatRate(undeliverable, sent),
    };
  });
}
