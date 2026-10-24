import type { CompanyProfile } from "@/lib/sales-sheet/company-profile-store";
import { fundingPlanCalc, type FundingLine, type FundingPlanCalc } from "../calc/funding-plan";
import { computeDealCalc } from "../calc/deal-calc";
import type { PropertyKindDef } from "../constants";
import type { RateTableRow } from "../rate-tables";
import { yen } from "../calc/format";
import type { FundingInputs } from "../funding-schema";
import type { DealDocText } from "../schemas";
import type { DealView } from "../view";
import { html, type SafeHtml } from "./html";
import { companyBlock, documentHtml } from "./layout";

export interface FundingPlanDocInput {
  deal: DealView;
  inputs: FundingInputs;
  calc: FundingPlanCalc;
  company: CompanyProfile;
  /** 作成日(日本時間の YYYY-MM-DD)。 */
  issuedOn: string;
  /** 取引の設定のロゴ(data: の URL)。PDF・プレビューだけに使う。 */
  logo?: string | null;
  /** 取引の設定の文面(あいさつ文・注意事項)。 */
  text?: DealDocText;
}

const money = (n: number | null) => (n === null ? "—" : `${yen(n)}円`);
const percent = (bp: number) => `${bp / 100}%`;
const dateJa = (ymd: string) => `${Number(ymd.slice(0, 4))}年${Number(ymd.slice(5, 7))}月${Number(ymd.slice(8, 10))}日`;

/** 空欄の行は出さない(お客様にお渡しする書類のため)。 */
const lineRows = (lines: FundingLine[]) =>
  lines.filter((l) => l.amount !== null).map((l) => html`<tr><th>${l.label}</th><td class="num">${money(l.amount)}</td></tr>`);

const notesList = (notes: string[]) => (notes.length ? html`<ul class="notes">${notes.map((n) => html`<li>${n}</li>`)}</ul>` : null);

function propertyRows(d: DealView): SafeHtml {
  const s = d.propertySnapshot;
  const name = [s.buildingName, s.roomNo].filter(Boolean).join(" ");
  return html`<table>
${name ? html`<tr><th style="width:30%">物件名</th><td>${name}</td></tr>` : null}
${s.address ? html`<tr><th style="width:30%">所在</th><td>${s.address}</td></tr>` : null}
</table>`;
}

function purchaseBody(c: FundingPlanCalc): SafeHtml {
  const p = c.purchase;
  const housing = p.monthlyHousing !== null;
  return html`
<h2>物件価格と諸費用</h2>
<table>
<tr><th style="width:60%">物件価格</th><td class="num">${money(c.price)}</td></tr>
${lineRows(p.lines)}
<tr class="total"><th>諸費用の合計</th><td class="num">${money(p.costsTotal)}</td></tr>
<tr class="total"><th>必要な資金の合計</th><td class="num">${money(p.total)}</td></tr>
</table>
<h2>資金の内訳</h2>
<table>
<tr><th style="width:60%">自己資金</th><td class="num">${money(p.ownFunds)}</td></tr>
<tr><th>借入額</th><td class="num">${money(p.loanAmount)}</td></tr>
</table>
${p.loans.length ? html`
<h2>ローンの比較(元利均等返済)</h2>
<table>
<tr><th></th>${p.loans.map((_, i) => html`<th class="num">パターン${i + 1}</th>`)}</tr>
<tr><th>金利・期間</th>${p.loans.map((l) => html`<td class="num">年${percent(l.annualRateBp)}・${l.years}年</td>`)}</tr>
<tr><th>月々の返済額</th>${p.loans.map((l) => html`<td class="num">${money(l.monthly)}</td>`)}</tr>
${housing ? html`<tr><th>管理費・修繕積立金など</th>${p.loans.map(() => html`<td class="num">${money(p.monthlyHousing)}</td>`)}</tr>
<tr class="total"><th>月々のお支払いの合計</th>${p.loans.map((l) => html`<td class="num">${money(l.monthlyTotal)}</td>`)}</tr>` : null}
</table>` : null}
${notesList(p.notes)}`;
}

function saleBody(c: FundingPlanCalc): SafeHtml {
  const s = c.sale;
  const t = s.tax;
  return html`
<h2>売却価格と費用</h2>
<table>
<tr><th style="width:60%">売却価格</th><td class="num">${money(c.price)}</td></tr>
${lineRows(s.lines)}
<tr class="total"><th>費用の合計</th><td class="num">${money(s.costsTotal)}</td></tr>
${s.loanBalance ? html`<tr><th>ローン残債</th><td class="num">${money(s.loanBalance)}</td></tr>` : null}
${s.settlementReceive ? html`<tr><th>精算金(固都税・管理費など)</th><td class="num">${money(s.settlementReceive)}</td></tr>` : null}
${s.depositOffset ? html`<tr><th>預り敷金の承継(残代金と相殺)</th><td class="num">${money(-s.depositOffset)}</td></tr>` : null}
<tr class="total"><th>手取り額(税引前)</th><td class="num">${money(s.netBeforeTax)}</td></tr>
</table>
<h2>譲渡所得税の目安</h2>
${t ? html`<table>
<tr><th style="width:60%">取得費${t.usedEstimatedCost ? "(不明のため売却価格の5%)" : ""}</th><td class="num">${money(t.acquisitionCost)}</td></tr>
<tr><th>譲渡所得</th><td class="num">${money(t.gain)}</td></tr>
${t.deduction ? html`<tr><th>特別控除(居住用)</th><td class="num">${money(t.deduction)}</td></tr>` : null}
<tr><th>課税される譲渡所得(${t.longTerm ? "長期" : "短期"})</th><td class="num">${money(t.taxable)}</td></tr>
<tr><th>所得税</th><td class="num">${money(t.incomeTax)}</td></tr>
<tr><th>復興特別所得税</th><td class="num">${money(t.reconstructionTax)}</td></tr>
<tr><th>住民税</th><td class="num">${money(t.residentTax)}</td></tr>
<tr class="total"><th>税額の合計(目安)</th><td class="num">${money(t.total)}</td></tr>
<tr class="total"><th>税引後の手取り額(目安)</th><td class="num">${money(s.netAfterTax)}</td></tr>
</table>` : null}
${notesList([s.taxNote, ...s.notes])}`;
}

/** 資金計画表(依頼書 4.1)の HTML。画面のプレビューと PDF で同じものを使う。 */
export function renderFundingPlanHtml(i: FundingPlanDocInput): string {
  const purchase = i.calc.mode === "purchase";
  const title = `資金計画表(${purchase ? "ご購入" : "ご売却"})`;
  return documentHtml({
    title,
    body: html`
<h1>${title}</h1>
<div class="meta">
<div class="customer">${i.inputs.customerName ?? ""} 様</div>
<div class="right">作成日 ${dateJa(i.issuedOn)}</div>
</div>
${i.text?.greeting ? html`<p class="greeting">${i.text.greeting}</p>` : null}
${propertyRows(i.deal)}
${purchase ? purchaseBody(i.calc) : saleBody(i.calc)}
${i.text?.notes ? html`<p class="remarks">${i.text.notes}</p>` : null}
${companyBlock(i.company, i.logo)}`,
  });
}

/** 取引・税率の表・入力から、資金計画表の計算と HTML をまとめて作る(プレビュー・PDF・Excel で共通)。 */
export function buildFundingPlan(a: {
  deal: DealView; rateRows: RateTableRow[]; kinds: PropertyKindDef[]; inputs: FundingInputs; company: CompanyProfile; today: string;
  /** 取引の設定のロゴ・文面(呼ぶ側が必ず渡す。無ければ null・undefined)。 */
  logo: string | null; text: DealDocText | undefined;
}): { calc: FundingPlanCalc; html: string } {
  const calc = fundingPlanCalc(a.deal, computeDealCalc(a.deal, a.rateRows, a.kinds, a.today), a.inputs, a.rateRows);
  return {
    calc,
    html: renderFundingPlanHtml({ deal: a.deal, inputs: a.inputs, calc, company: a.company, issuedOn: a.today, logo: a.logo, text: a.text }),
  };
}
