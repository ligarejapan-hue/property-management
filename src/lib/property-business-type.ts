import { DEAL_BUSINESS_TYPES, DEAL_BUSINESS_TYPE_LABELS, type DealBusinessType } from "@/lib/deals/constants";

/**
 * 物件の取扱区分(仲介 / 買取再販 / 未定・2026-11-04 発注者)。
 * 値は取引の事業区分(businessType)と同じ。物件の欄は取引を作るときの初期値になり、
 * 取引と食い違ったら物件の画面で知らせる。⚠Prisma を読まない(画面からも使う)。
 */

export const PROPERTY_BUSINESS_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "(未定)" },
  ...DEAL_BUSINESS_TYPES.map((v) => ({ value: v, label: DEAL_BUSINESS_TYPE_LABELS[v] })),
];

/** 物件一覧の絞り込みの値。none=未定(欄が空)。 */
export const PROPERTY_BUSINESS_TYPE_FILTER_VALUES = [...DEAL_BUSINESS_TYPES, "none"] as const;
export const PROPERTY_BUSINESS_TYPE_FILTER_OPTIONS: Array<{ value: string; label: string }> = [
  ...DEAL_BUSINESS_TYPES.map((v) => ({ value: v, label: DEAL_BUSINESS_TYPE_LABELS[v] })),
  { value: "none", label: "未定" },
];

/** 一覧の絞り込みの値を検索条件に。none=未定(NULL)。 */
export function businessTypeWhere(v: (typeof PROPERTY_BUSINESS_TYPE_FILTER_VALUES)[number]): string | null {
  return v === "none" ? null : v;
}

const isBusinessType =(v: string | null | undefined): v is DealBusinessType =>
  !!v && (DEAL_BUSINESS_TYPES as readonly string[]).includes(v);

/** 画面に出す名前。空は「未定」・知らない値はそのまま。 */
export function businessTypeLabel(v: string | null | undefined): string {
  if (!v) return "未定";
  return isBusinessType(v) ? DEAL_BUSINESS_TYPE_LABELS[v] : v;
}

/** 外から来た値(URL など)を取扱区分として読む。知らない値は null。 */
export function parseBusinessType(v: string | null | undefined): DealBusinessType | null {
  return isBusinessType(v) ? v : null;
}

/** 新しい取引の事業区分の初期値。物件が未定なら今までどおり仲介。 */
export function initialDealBusinessType(v: string | null | undefined): DealBusinessType {
  return isBusinessType(v) ? v : "brokerage";
}

/** 物件から新しい取引を作る画面への道。取扱区分があれば事業区分の初期値として渡す。 */
export function newDealHref(propertyId: string, businessType: string | null | undefined): string {
  const q = new URLSearchParams({ propertyId });
  if (isBusinessType(businessType)) q.set("businessType", businessType);
  return `/deals/new?${q.toString()}`;
}

export type DealSide ="purchase" | "sale";
const SIDE_LABELS: Record<DealSide, string> = { purchase: "仕入", sale: "売却" };

/**
 * 買取再販の取引が仕入か売却か。買主が自社=仕入・売主が自社=売却。
 * 自社がいない・両方にいる(入力の誤り)・仲介の取引は null(決めない)。
 */
export function dealSideOf(
  businessType: string,
  parties: Array<{ role: string; isSelf: boolean }>,
): DealSide | null {
  if (businessType !== "resale") return null;
  const buyer = parties.some((p) => p.role === "buyer" && p.isSelf);
  const seller = parties.some((p) => p.role === "seller" && p.isSelf);
  if (buyer === seller) return null;
  return buyer ? "purchase" : "sale";
}

export interface PropertyDealSummary {
  id: string;
  dealNo: string;
  businessType: string;
  status: string;
  side: DealSide | null;
  /** 「買取再販(仕入)」「仲介」など。 */
  label: string;
}

/** 物件の基本情報に並べる取引(並びは渡された順)。 */
export function summarizePropertyDeals(
  deals: Array<{ id: string; dealNo: string; businessType: string; status: string; parties: Array<{ role: string; isSelf: boolean }> }>,
): PropertyDealSummary[] {
  return deals.map((d) => {
    const side = dealSideOf(d.businessType, d.parties);
    const name = businessTypeLabel(d.businessType);
    return {
      id: d.id, dealNo: d.dealNo, businessType: d.businessType, status: d.status, side,
      label: side ? `${name}(${SIDE_LABELS[side]})` : name,
    };
  });
}

/** 物件の取扱区分と違う区分の取引があるか。物件が未定・中止の取引は数えない。 */
export function businessTypeMismatch(
  propertyType: string | null | undefined,
  deals: Array<{ businessType: string; status?: string }>,
): boolean {
  if (!propertyType) return false;
  return deals.some((d) => d.status !== "cancelled" && d.businessType !== propertyType);
}
