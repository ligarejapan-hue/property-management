/**
 * 添付ファイルがどの取引の書類か(買取再販の仕入/売却を分ける・2026-11-04 発注者 案A)。
 * - 確定: dealId=その取引 / dealCommon=true は「共通」。
 * - 未区分(両方空): 仕入の決済日(日本時間の日)までに入れたものは仕入、後は売却と**推定**して出す。
 *   謄本・調査資料は共通と推定(発注者決定)。推定はデータに書かない=人が「推定どおりに確定」で書く。
 * ⚠Prisma を読まない(画面からも使う)。
 */

export interface ScopeDeal {
  id: string;
  dealNo: string;
  status: string;
  side: "purchase" | "sale" | null;
  /** 事業区分(brokerage=仲介 / resale=買取再販)。無い=買取再販の扱い(古い呼び出し)。 */
  businessType?: string;
  /** 仲介の取引態様(buyer=買主側 / seller=売主側 / both=両手 / 空=未入力)。 */
  tradeSide?: string | null;
  /** ISO 文字列。 */
  settlementAt: string | null;
  createdAt: string;
}

export interface ScopeAttachment {
  id: string;
  type?: string;
  docStage?: string | null;
  dealId?: string | null;
  dealCommon?: boolean;
  createdAt: string;
}

/** "common"=共通 / 取引の id / null=分からない。 */
export type DealScope = string | null;

const SIDE_LABELS = { purchase: "仕入", sale: "売却" } as const;
const BROKERAGE_LABELS: Record<string, string> = { buyer: "購入仲介", seller: "売却仲介", both: "両手仲介" };

const isBrokerage = (d: ScopeDeal) => d.businessType === "brokerage";

/**
 * 分ける取引(中止していない・並びは渡された順)。
 * 買取再販は仕入/売却の分かる取引を1件からでも分ける。仲介は分けられる取引が2件以上あるときだけ(1件なら今までどおり)。
 */
export function splitDealsOf(deals: readonly ScopeDeal[]): ScopeDeal[] {
  const candidates = deals.filter((d) => d.status !== "cancelled" && (d.side !== null || isBrokerage(d)));
  const withBrokerage = candidates.length >= 2;
  return candidates.filter((d) => d.side !== null || withBrokerage);
}

/** 取引の名前(「仕入」「購入仲介」など)。 */
function dealKindLabel(d: ScopeDeal): string {
  if (d.side) return SIDE_LABELS[d.side];
  return BROKERAGE_LABELS[d.tradeSide ?? ""] ?? "仲介";
}

/**
 * 取引の画面から入れた書類に、画面に出さずに付ける取引(2026-11-24 発注者 案ア)。
 * 仲介の取引が1件だけで分けない物件でも、あとで取引が増えたときに正しく分かれるように。分ける物件・その他は null。
 */
export function quietUploadDealOf(deals: readonly ScopeDeal[] | null | undefined, fixedDealId: string | null | undefined): string | null {
  if (!deals || !fixedDealId || splitDealsOf(deals).length > 0) return null;
  const d = deals.find((x) => x.id === fixedDealId);
  return d && isBrokerage(d) && d.status !== "cancelled" ? d.id : null;
}

/** 日本時間の日("YYYY-MM-DD")。 */
function jstDay(iso: string): string {
  return new Date(Date.parse(iso) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 「共通」と推定する書類(謄本・調査資料)。 */
function isCommonByNature(a: ScopeAttachment): boolean {
  return a.type === "registry" || a.docStage === "pre_contract";
}

function estimate(a: ScopeAttachment, deals: readonly ScopeDeal[]): DealScope {
  const split = splitDealsOf(deals);
  // 分ける取引が無い物件では推定しない(分ける意味が無い)。
  if (split.length === 0) return null;
  if (isCommonByNature(a)) return "common";
  if (split.some(isBrokerage)) return estimateByOrder(a, split);
  // 新しい順に来るので、最初に見つかったものがいちばん新しい取引。
  const purchase = split.find((d) => d.side === "purchase");
  const sale = split.find((d) => d.side === "sale");
  if (purchase && sale) {
    const boundary = purchase.settlementAt ?? sale.createdAt;
    return jstDay(a.createdAt) <= jstDay(boundary) ? purchase.id : sale.id;
  }
  return purchase?.id ?? sale?.id ?? null;
}

/** 仲介が入る物件: 作った順に並べ、前の取引の決済日(無ければ次の取引を作った日)までは前の取引。 */
function estimateByOrder(a: ScopeAttachment, split: readonly ScopeDeal[]): DealScope {
  const ordered = [...split].sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt));
  const day = jstDay(a.createdAt);
  for (let i = 0; i < ordered.length - 1; i++) {
    const boundary = ordered[i].settlementAt ?? ordered[i + 1].createdAt;
    if (day <= jstDay(boundary)) return ordered[i].id;
  }
  return ordered[ordered.length - 1].id;
}

/** 添付の取引。estimated=true は推定(まだ確定していない)。 */
export function dealScopeOf(a: ScopeAttachment, deals: readonly ScopeDeal[]): { scope: DealScope; estimated: boolean } {
  if (a.dealId) return { scope: a.dealId, estimated: false };
  if (a.dealCommon) return { scope: "common", estimated: false };
  const scope = estimate(a, deals);
  return { scope, estimated: scope !== null };
}

/** 「推定どおりに確定」で送る分(推定がある未区分だけ)。 */
export function estimatedAssignments(
  items: readonly ScopeAttachment[],
  deals: readonly ScopeDeal[],
): Array<{ attachmentId: string; scope: string }> {
  const out: Array<{ attachmentId: string; scope: string }> = [];
  for (const a of items) {
    const r = dealScopeOf(a, deals);
    if (r.estimated && r.scope !== null) out.push({ attachmentId: a.id, scope: r.scope });
  }
  return out;
}

/** 絞り込み。"all"=すべて / "unset"=確定していないもの / "common" / 取引の id(推定も含める)。 */
export function filterByScope<T extends ScopeAttachment>(items: readonly T[], deals: readonly ScopeDeal[], filter: string): T[] {
  if (filter === "all") return [...items];
  return items.filter((a) => {
    const r = dealScopeOf(a, deals);
    if (filter === "unset") return r.estimated || r.scope === null;
    return r.scope === filter;
  });
}

/** 取引の選択肢(「仕入 2026-0012」「購入仲介 2026-0007」)+共通。 */
export function dealScopeOptions(deals: readonly ScopeDeal[]): Array<{ value: string; label: string }> {
  return [
    ...splitDealsOf(deals).map((d) => ({ value: d.id, label: `${dealKindLabel(d)} ${d.dealNo}` })),
    { value: "common", label: "共通" },
  ];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 送られた値を列の値に。"common"=共通・uuid=その取引・null=未区分に戻す。読めない値は undefined。 */
export function parseScopeInput(v: string | null): { dealId: string | null; dealCommon: boolean } | undefined {
  if (v === null) return { dealId: null, dealCommon: false };
  if (v === "common") return { dealId: null, dealCommon: true };
  if (UUID.test(v)) return { dealId: v.toLowerCase(), dealCommon: false };
  return undefined;
}
