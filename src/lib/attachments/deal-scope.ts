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

/** 仕入・売却に分ける取引(仕入/売却の分かる・中止していない取引)。並びは渡された順。 */
export function splitDealsOf(deals: readonly ScopeDeal[]): ScopeDeal[] {
  return deals.filter((d) => d.side !== null && d.status !== "cancelled");
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
  // 新しい順に来るので、最初に見つかったものがいちばん新しい取引。
  const purchase = split.find((d) => d.side === "purchase");
  const sale = split.find((d) => d.side === "sale");
  if (purchase && sale) {
    const boundary = purchase.settlementAt ?? sale.createdAt;
    return jstDay(a.createdAt) <= jstDay(boundary) ? purchase.id : sale.id;
  }
  return purchase?.id ?? sale?.id ?? null;
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

/** 取引の選択肢(「仕入 2026-0012」)+共通。 */
export function dealScopeOptions(deals: readonly ScopeDeal[]): Array<{ value: string; label: string }> {
  return [
    ...splitDealsOf(deals).map((d) => ({ value: d.id, label: `${SIDE_LABELS[d.side as "purchase" | "sale"]} ${d.dealNo}` })),
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
