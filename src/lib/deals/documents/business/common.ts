import type { CompanyProfile } from "@/lib/sales-sheet/company-profile-store";
import type { DealCalc } from "../../calc/deal-calc";
import type { RateTableRow } from "../../rate-tables";
import type { DealSettingsView } from "../../settings";
import type { DealPartyView, DealView } from "../../view";
import { yen } from "../../calc/format";
import { formatJstDateTime } from "../../datetime";
import { html, type SafeHtml } from "../html";

/** 業務書類を組み立てるのに使うもの(発行・確認の両方で同じ)。 */
export interface BusinessDocContext {
  deal: DealView;
  calc: DealCalc;
  settings: DealSettingsView;
  company: CompanyProfile;
  rateRows: RateTableRow[];
  /** 作成日(日本時間の YYYY-MM-DD)。 */
  today: string;
  /** 取引の設定のロゴ・角印(data: の URL)。 */
  logo: string | null;
  seal: string | null;
}

/** Excel(値だけ)の1行。見出しは value 無し。 */
export type ValueRow = { label: string; value?: string | number | null; heading?: boolean };

export const DASH = "—";
export const money = (n: number | null | undefined) => (n === null || n === undefined ? DASH : `${yen(n)}円`);
export const dateJa = (ymd: string) => `${Number(ymd.slice(0, 4))}年${Number(ymd.slice(5, 7))}月${Number(ymd.slice(8, 10))}日`;
export const dateTimeJa = (iso: string | null) => (iso ? formatJstDateTime(iso) : DASH);

export const partiesOf = (deal: DealView, role: DealPartyView["role"]) => deal.parties.filter((p) => p.role === role);
/** 当事者の名前(複数は「・」でつなぐ)。いなければ null。 */
export function namesOf(ps: DealPartyView[]): string | null {
  return ps.length ? ps.map((p) => p.name).join("・") : null;
}

/** 物件の書き方(物件名 号室・所在)。 */
export function propertyLabel(deal: DealView): string {
  const s = deal.propertySnapshot;
  const name = [s.buildingName, s.roomNo].filter(Boolean).join(" ");
  return [name, s.address].filter(Boolean).join(" / ") || DASH;
}

/** 書類の頭の表(項目と値)。値が無い行は「—」。 */
export function headTable(rows: [string, string | null][]): SafeHtml {
  return html`<table>${rows.map(([k, v]) => html`<tr><th style="width:28%">${k}</th><td>${v ?? DASH}</td></tr>`)}</table>`;
}
