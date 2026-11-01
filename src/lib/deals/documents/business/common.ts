import type { CompanyProfile } from "@/lib/sales-sheet/company-profile-store";
import type { DealCalc } from "../../calc/deal-calc";
import type { RateTableRow } from "../../rate-tables";
import type { DealSettingsView } from "../../settings";
import type { DealPartyView, DealView } from "../../view";
import { yen } from "../../calc/format";
import { BANK_ACCOUNT_TYPE_LABELS } from "../../constants";
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
  /** 取引の営業担当・業務担当の名前(書類確認書の頭・無ければ「—」)。 */
  staff?: { sales: string | null; ops: string | null };
  /** 物件の謄本(全部事項)の登記の現況(書類確認書だけ・名前は入れない・計画 段5c-2)。 */
  registry?: { activeRights: number; caution: string | null };
  /** お客様の提出ですべて受領になった項目(書類確認書の確認欄に ✓ を付ける)。 */
  receivedItemIds?: ReadonlySet<string>;
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

/** 発行のときに当事者などから選ぶ値(画面の選択肢)。 */
export interface Choice { value: string; label: string }

export const LEASE_CONTRACT_LABELS: Record<string, string> = { ordinary: "普通借家", fixed_term: "定期借家" };

/** 署名・押印の欄(どの書類でも常に空欄・設計 §4.4)。 */
export function signBox(label: string): SafeHtml {
  return html`<div style="border:1px solid #333;padding:2mm 3mm;margin-top:2mm;height:20mm;width:60mm;margin-left:auto;font-size:9pt">${label}</div>`;
}

/** 取引の設定の振込先口座を1行に。銀行名が無ければ null。 */
export function bankAccountText(c: { settings: Pick<DealSettingsView, "bankAccount"> }): string | null {
  const b = c.settings.bankAccount;
  if (!b.bankName) return null;
  return [b.bankName, b.branchName, b.accountType ? BANK_ACCOUNT_TYPE_LABELS[b.accountType] : null, b.accountNumber, b.accountHolder && `名義 ${b.accountHolder}`]
    .filter(Boolean).join(" ");
}
