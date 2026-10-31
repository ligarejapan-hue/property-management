import { CROSSCHECK_DOC_FIELDS, normalizeDate, type CrosscheckDocument, type IssuedDocFacts } from "./crosscheck";
import { dealDocumentTitle } from "./documents/issue";
import { jstDateString } from "./datetime";
import type { DealView } from "./view";

/** 発行の写し(calcSnapshot)に残す鍵。名前・住所は入れない。 */
export const CROSSCHECK_FACTS_KEY = "crosscheckFacts";

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const numOrNull = (v: unknown): number | null | undefined => (typeof v === "number" || v === null ? v : undefined);

/**
 * 発行のときに残す値。その書類が使う項目だけ(使わない項目は残さない=あとで値が変わっても食い違いにしない)。
 * activeRights = 書類確認書が抹消の項目を足すのに使った件数(謄本を読めなかった人の発行は 0 のまま残る=あとで不一致に出る)。
 */
export function buildCrosscheckFacts(
  docType: string, deal: Pick<DealView, "price" | "settlementAt" | "propertySnapshot">, registry?: { activeRights: number },
): CrosscheckDocument {
  const out: CrosscheckDocument = {};
  if (CROSSCHECK_DOC_FIELDS.price.includes(docType)) out.price = deal.price;
  // 賃貸人変更のお知らせの日付は発行のときに選ぶ変更日(inputSnapshot に残る)。
  if (CROSSCHECK_DOC_FIELDS.settlementDate.includes(docType) && docType !== "landlord_change_notice") {
    out.settlementDate = deal.settlementAt ? jstDateString(new Date(deal.settlementAt)) : null;
  }
  if (CROSSCHECK_DOC_FIELDS.area.includes(docType)) {
    out.floorArea = deal.propertySnapshot.floorArea;
    out.landArea = deal.propertySnapshot.landArea;
  }
  if (CROSSCHECK_DOC_FIELDS.activeRights.includes(docType) && registry) out.activeRights = registry.activeRights;
  return out;
}

/** この機能より前に発行した書類からも読める値(資金計画表・事業計画書の計算の結果)。 */
function legacyFacts(docType: string, calc: Record<string, unknown>): CrosscheckDocument {
  if (docType === "funding_plan") {
    const price = numOrNull(calc.price);
    return price === undefined ? {} : { price };
  }
  if (docType === "business_plan") {
    const out: CrosscheckDocument = {};
    const price = numOrNull(obj(calc.purchase).priceIncl);
    if (price !== undefined) out.price = price;
    const area = numOrNull(calc.areaSqm);
    if (area !== undefined) {
      if (calc.kindBase === "unit") out.floorArea = area;
      else out.landArea = area;
    }
    return out;
  }
  return {};
}

/** 残っている値を読む。形が違う値は無かったことにする(=確認できない)。 */
function readFacts(raw: unknown): CrosscheckDocument {
  const f = obj(raw);
  const out: CrosscheckDocument = {};
  for (const k of ["price", "floorArea", "landArea", "activeRights"] as const) {
    const v = numOrNull(f[k]);
    if (v !== undefined) out[k] = v;
  }
  if (typeof f.settlementDate === "string" || f.settlementDate === null) out.settlementDate = f.settlementDate;
  return out;
}

export interface IssuedDocRow {
  id: string; docType: string; variant: string; version: number; issuedAt: Date; inputSnapshot: unknown; calcSnapshot: unknown;
}

export function readIssuedFacts(r: IssuedDocRow): IssuedDocFacts {
  const calc = obj(r.calcSnapshot);
  const out: IssuedDocFacts = {
    documentId: r.id, docType: r.docType, variant: r.variant, version: r.version,
    title: dealDocumentTitle(r.docType, r.variant), issuedAt: r.issuedAt.toISOString(),
    ...legacyFacts(r.docType, calc), ...readFacts(calc[CROSSCHECK_FACTS_KEY]),
  };
  if (r.docType === "landlord_change_notice") {
    const on = obj(obj(r.inputSnapshot).options).changeOn;
    if (typeof on === "string") out.settlementDate = normalizeDate(on) ?? on;
    else if (on === null) out.settlementDate = null;
  }
  return out;
}

/** 種類・出し分けごとの最新版(rows は新しい順)。 */
export function latestIssuedDocs<T extends { docType: string; variant: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = `${r.docType}\u0000${r.variant}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
