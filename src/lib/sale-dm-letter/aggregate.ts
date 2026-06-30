import { deriveOutcome } from "./outcome";

export interface AggregateDraftInput {
  variantId: string;
  deliveryStatus: string; // "unknown" | "delivered" | "returned_undeliverable" | "returned_other"
  lpFirstAccessAt: Date | null;
  phoneInquiryAt: Date | null;
}

export interface VariantAggregate {
  variantId: string;
  sent: number; // 送付数 = 該当型の draft 数
  delivered: number; // 到達数 = deliveryStatus===delivered
  undeliverable: number; // 宛先不明 = deliveryStatus===returned_undeliverable
  inquiry: number; // 反響(LP∪電話。重複は1)
  inquiryLp: number; // LP 反響件数
  inquiryPhone: number; // 電話 反響件数
  inquiryBoth: number; // LP と電話の両方を持つ件数
  responseRate: number | null; // 反響率 = (到達のうち反響した数) / 到達数。到達0なら null
  undeliverableRate: number | null; // 宛先不明率 = 宛先不明数 / 送付数。送付0なら null
}

export interface CampaignAggregate {
  byVariant: VariantAggregate[];
  total: VariantAggregate;
}

function emptyAggregate(variantId: string): VariantAggregate {
  return {
    variantId,
    sent: 0,
    delivered: 0,
    undeliverable: 0,
    inquiry: 0,
    inquiryLp: 0,
    inquiryPhone: 0,
    inquiryBoth: 0,
    responseRate: null,
    undeliverableRate: null,
  };
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

// 1ドラフトを集計バケットへ反映する(byVariant と total で共有)。
// deliveredResponded は「到達かつ反響」= 反響率の分子。
function accumulate(
  agg: VariantAggregate,
  draft: AggregateDraftInput,
  counters: { deliveredResponded: number },
): { deliveredResponded: number } {
  agg.sent += 1;
  const isDelivered = draft.deliveryStatus === "delivered";
  const isUndeliverable = draft.deliveryStatus === "returned_undeliverable";
  if (isDelivered) agg.delivered += 1;
  if (isUndeliverable) agg.undeliverable += 1;

  const hasLp = draft.lpFirstAccessAt != null;
  const hasPhone = draft.phoneInquiryAt != null;
  const isInquiry = deriveOutcome(draft) === "inquiry";
  if (hasLp) agg.inquiryLp += 1;
  if (hasPhone) agg.inquiryPhone += 1;
  if (hasLp && hasPhone) agg.inquiryBoth += 1;
  if (isInquiry) agg.inquiry += 1;

  let { deliveredResponded } = counters;
  if (isDelivered && isInquiry) deliveredResponded += 1;
  return { deliveredResponded };
}

export function aggregateByVariant(drafts: AggregateDraftInput[]): CampaignAggregate {
  const map = new Map<string, { agg: VariantAggregate; deliveredResponded: number }>();
  const total = emptyAggregate("__total__");
  let totalDeliveredResponded = 0;

  for (const draft of drafts) {
    let bucket = map.get(draft.variantId);
    if (!bucket) {
      bucket = { agg: emptyAggregate(draft.variantId), deliveredResponded: 0 };
      map.set(draft.variantId, bucket);
    }
    bucket.deliveredResponded = accumulate(bucket.agg, draft, {
      deliveredResponded: bucket.deliveredResponded,
    }).deliveredResponded;
    totalDeliveredResponded = accumulate(total, draft, {
      deliveredResponded: totalDeliveredResponded,
    }).deliveredResponded;
  }

  const byVariant = Array.from(map.values())
    .map(({ agg, deliveredResponded }) => {
      agg.responseRate = rate(deliveredResponded, agg.delivered);
      agg.undeliverableRate = rate(agg.undeliverable, agg.sent);
      return agg;
    })
    .sort((a, b) => a.variantId.localeCompare(b.variantId));

  total.responseRate = rate(totalDeliveredResponded, total.delivered);
  total.undeliverableRate = rate(total.undeliverable, total.sent);

  return { byVariant, total };
}
