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

// ---- 二軸集計(設計 2026-09-08 §2.1)。DM型=閲覧率、LP型=閲覧(申込率は PR4 で追加)、組み合わせ表。
//
// ⚠「閲覧」の定義は表によって違う(@codex R10 P1)。
//   - DM型ごと: lpFirstAccessAt(QRを読み取られた)。文面の成績=「読んでもらえたか」に一番近く、
//     飛び先がアプリ内ページでも外部LPでも等しく立つ。
//   - LP型ごと / 組み合わせ: lpPageFirstAt(アプリ内ご案内ページを実際に返せた)。公開スイッチ未投入・
//     LP型に文章なし・読み出し失敗のときは外部LPへ転送しており、そこでの訪問を「ページの成績」として
//     数えると、LP型の比較が外部LPへの訪問で汚れる。
export const LP_NONE = "__none__";

export interface TwoAxisDraftInput extends AggregateDraftInput {
  lpVariantId: string | null;
  // アプリ内ご案内ページを実際に返せた初回時刻。返せていなければ null(QRだけ読まれた場合も null)。
  lpPageFirstAt: Date | null;
  // 電話ボタンのタップ(公開LP §2.4)。初回タップ時刻・タップされていなければ null。
  // 閲覧とは独立に立つ(記録に失敗して閲覧が付かずタップだけ、ということもあり得る)。
  phoneTapFirstAt: Date | null;
}
interface ViewBucket { sent: number; delivered: number; viewed: number; deliveredViewed: number; phoneTapped: number }
export interface DmViewAggregate { variantId: string; sent: number; delivered: number; viewed: number; deliveredViewed: number; viewRate: number | null }
// phoneTapped: 電話ボタンをタップした件数(phoneTapFirstAt != null)。
// phoneTapRate: phoneTapped / viewed(この表の viewed = アプリ内ページを返せた閲覧)。閲覧0 のときは null。
// 閲覧なしのタップも分子には数えるため、データ上は viewed より phoneTapped が多く率が100%を超える
// こともあり得る(クランプしない・そのまま出す)。
export interface LpVariantAggregate { lpVariantId: string; sent: number; delivered: number; viewed: number; deliveredViewed: number; viewRate: number | null; phoneTapped: number; phoneTapRate: number | null }
export interface PairAggregate { variantId: string; lpVariantId: string; sent: number; delivered: number; viewed: number }
export interface TwoAxisAggregate { byDmVariant: DmViewAggregate[]; byLpVariant: LpVariantAggregate[]; byPair: PairAggregate[] }

// isViewed は呼び出し側が渡す(表ごとに「閲覧」の定義が違うため・上の注記)。
function bump(map: Map<string, ViewBucket>, key: string, draft: TwoAxisDraftInput, isViewed: boolean): void {
  const b = map.get(key) ?? { sent: 0, delivered: 0, viewed: 0, deliveredViewed: 0, phoneTapped: 0 };
  const isDelivered = draft.deliveryStatus === "delivered";
  b.sent += 1;
  if (isDelivered) b.delivered += 1;
  if (isViewed) b.viewed += 1;
  if (isDelivered && isViewed) b.deliveredViewed += 1;
  if (draft.phoneTapFirstAt != null) b.phoneTapped += 1;
  map.set(key, b);
}

export function aggregateTwoAxis(drafts: TwoAxisDraftInput[]): TwoAxisAggregate {
  const dm = new Map<string, ViewBucket>();
  const lp = new Map<string, ViewBucket>();
  const pair = new Map<string, ViewBucket>();
  for (const draft of drafts) {
    const lpKey = draft.lpVariantId ?? LP_NONE;
    // DM型=QRの読み取り / LP型・組み合わせ=アプリ内ページを実際に返せた閲覧。
    const qrViewed = draft.lpFirstAccessAt != null;
    const pageViewed = draft.lpPageFirstAt != null;
    bump(dm, draft.variantId, draft, qrViewed);
    bump(lp, lpKey, draft, pageViewed);
    bump(pair, `${draft.variantId}|${lpKey}`, draft, pageViewed);
  }
  const sortKeys = (m: Map<string, ViewBucket>) => [...m.keys()].sort((a, b) => a.localeCompare(b));
  return {
    byDmVariant: sortKeys(dm).map((k) => { const b = dm.get(k)!; return { variantId: k, sent: b.sent, delivered: b.delivered, viewed: b.viewed, deliveredViewed: b.deliveredViewed, viewRate: rate(b.deliveredViewed, b.delivered) }; }),
    byLpVariant: sortKeys(lp).map((k) => { const b = lp.get(k)!; return { lpVariantId: k, sent: b.sent, delivered: b.delivered, viewed: b.viewed, deliveredViewed: b.deliveredViewed, viewRate: rate(b.deliveredViewed, b.delivered), phoneTapped: b.phoneTapped, phoneTapRate: rate(b.phoneTapped, b.viewed) }; }),
    byPair: sortKeys(pair).map((k) => { const b = pair.get(k)!; const [variantId, lpVariantId] = k.split("|"); return { variantId, lpVariantId, sent: b.sent, delivered: b.delivered, viewed: b.viewed }; }),
  };
}
