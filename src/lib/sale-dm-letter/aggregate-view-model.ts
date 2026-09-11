import type { SaleDmCampaign } from "@/lib/api-client";
import { isInquiry } from "./recipient-actions";
import { aggregateTwoAxis, LP_NONE } from "./aggregate";

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
    // 送付済み(status==="sent")の宛先のみ集計対象。draft/confirmed(未送付)は配達/反響結果を持てないため、
    // 送付数の母数に含めると未送付を送付済みと誤計上し、宛先不明率/反響率を希釈する(サーバ集計と一致)。
    const drafts = campaign.recipients.filter((r) => r.variantId === v.id && r.status === "sent");
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

export const LP_NONE_LABEL = "LP型なし(外部LP)";

// SaleDmDraft(api-client.ts)は電話タップの生値をまだ型に持たない(サーバの応答には
// phoneTapFirstAt が載っている・api-client.ts は Task 6 と同時編集中のため別ファイルで型を広げる)。
type DraftWithPhoneTap = SaleDmCampaign["recipients"][number] & { phoneTapFirstAt?: string | null };

function sentDraftsForTwoAxis(campaign: SaleDmCampaign) {
  return (campaign.recipients as DraftWithPhoneTap[])
    .filter((r) => r.status === "sent")
    .map((r) => ({
      variantId: r.variantId,
      lpVariantId: r.lpVariantId ?? null,
      deliveryStatus: r.deliveryStatus,
      lpFirstAccessAt: r.lpFirstAccessAt ? new Date(r.lpFirstAccessAt) : null,
      phoneInquiryAt: r.phoneInquiryAt ? new Date(r.phoneInquiryAt) : null,
      phoneTapFirstAt: r.phoneTapFirstAt ? new Date(r.phoneTapFirstAt) : null,
    }));
}

export interface DmViewRow { variantId: string; label: string; delivered: number; viewed: number; viewRate: string }
// phoneTapLabel: 「件数 / 閲覧 分母(率%)」の表示文字列(分母=閲覧の分母を明示)。閲覧0は "—"。
export interface LpVariantRow { lpVariantId: string; label: string; sent: number; delivered: number; viewed: number; viewRate: string; phoneTapped: number; phoneTapLabel: string }
export interface PairRow { key: string; label: string; sent: number; delivered: number; viewed: number }

// 電話タップの表示: 「件数 / 閲覧数(率%)」。閲覧0(分母0)は率が定義できないため "—"。
function formatPhoneTapLabel(phoneTapped: number, viewed: number): string {
  if (viewed <= 0) return "—";
  return `${phoneTapped} / ${viewed} (${((phoneTapped / viewed) * 100).toFixed(0)}%)`;
}

// DM型の成績 = 閲覧率(設計 2026-09-08 §2.1)。到達かつ閲覧 ÷ 到達。
export function buildDmViewRows(campaign: SaleDmCampaign): DmViewRow[] {
  const label = new Map(campaign.variants.map((v) => [v.id, v.label]));
  return aggregateTwoAxis(sentDraftsForTwoAxis(campaign)).byDmVariant.map((v) => ({
    variantId: v.variantId,
    label: label.get(v.variantId) ?? v.variantId,
    delivered: v.delivered,
    viewed: v.viewed,
    viewRate: formatRate(v.deliveredViewed, v.delivered),
  }));
}

export function buildLpVariantRows(campaign: SaleDmCampaign): LpVariantRow[] {
  if (campaign.lpVariants.length === 0) return [];
  const label = new Map(campaign.lpVariants.map((v) => [v.id, v.label]));
  return aggregateTwoAxis(sentDraftsForTwoAxis(campaign)).byLpVariant.map((v) => ({
    lpVariantId: v.lpVariantId,
    label: v.lpVariantId === LP_NONE ? LP_NONE_LABEL : (label.get(v.lpVariantId) ?? v.lpVariantId),
    sent: v.sent,
    delivered: v.delivered,
    viewed: v.viewed,
    viewRate: formatRate(v.deliveredViewed, v.delivered),
    phoneTapped: v.phoneTapped,
    phoneTapLabel: formatPhoneTapLabel(v.phoneTapped, v.viewed),
  }));
}

export function buildPairRows(campaign: SaleDmCampaign): PairRow[] {
  if (campaign.lpVariants.length === 0) return [];
  const dm = new Map(campaign.variants.map((v) => [v.id, v.label]));
  const lp = new Map(campaign.lpVariants.map((v) => [v.id, v.label]));
  return aggregateTwoAxis(sentDraftsForTwoAxis(campaign)).byPair.map((p) => ({
    key: `${p.variantId}|${p.lpVariantId}`,
    label: `${dm.get(p.variantId) ?? p.variantId} × ${p.lpVariantId === LP_NONE ? "LP型なし" : (lp.get(p.lpVariantId) ?? p.lpVariantId)}`,
    sent: p.sent,
    delivered: p.delivered,
    viewed: p.viewed,
  }));
}
