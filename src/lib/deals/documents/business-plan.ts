import type { CompanyProfile } from "@/lib/sales-sheet/company-profile-store";
import { businessPlanCalc, type BusinessLine, type BusinessPlanCalc } from "../calc/business-plan";
import { computeDealCalc } from "../calc/deal-calc";
import { yen } from "../calc/format";
import type { PropertyKindDef } from "../constants";
import type { RateTableRow } from "../rate-tables";
import type { DealView } from "../view";
import {
  BUSINESS_VARIANT_LABELS, COMPARABLE_KIND_LABELS, REPAYMENT_LABELS, type BusinessInputs,
} from "../business-schema";
import { businessPlanSections, type BusinessSectionKey, type SectionMatrix } from "../business-sections";
import { html, type SafeHtml } from "./html";
import { companyBlock, documentHtml } from "./layout";

export interface BusinessPlanDocInput {
  deal: DealView;
  inputs: BusinessInputs;
  calc: BusinessPlanCalc;
  sections: BusinessSectionKey[];
  kindLabel: string | null;
  company: CompanyProfile;
  /** 作成日(日本時間の YYYY-MM-DD)。 */
  issuedOn: string;
  logo?: string | null;
}

const DASH = "—";
const money = (n: number | null) => (n === null ? DASH : `${yen(n)}円`);
const percent = (bp: number | null) => (bp === null ? DASH : `${(bp / 100).toFixed(2)}%`);
const dateJa = (ymd: string) => `${Number(ymd.slice(0, 4))}年${Number(ymd.slice(5, 7))}月${Number(ymd.slice(8, 10))}日`;
const area = (n: number | null) => (n === null ? DASH : `${n}㎡`);

const row = (label: string, value: string, total = false) =>
  html`<tr${total ? html` class="total"` : null}><th style="width:60%">${label}</th><td class="num">${value}</td></tr>`;
/** 空欄の行は出さない。 */
const lineRows = (lines: BusinessLine[]) => lines.filter((l) => l.amount !== null).map((l) => row(l.label, money(l.amount)));

function overview(i: BusinessPlanDocInput): SafeHtml {
  const s = i.deal.propertySnapshot;
  const unit = i.calc.kindBase === "unit";
  const built = s.builtYear ? `${s.builtYear}年${s.builtMonth ? `${s.builtMonth}月` : ""}` : DASH;
  return html`<h2>物件概要</h2><table>
<tr><th style="width:30%">物件名</th><td>${[s.buildingName, s.roomNo].filter(Boolean).join(" ") || DASH}</td></tr>
<tr><th>所在</th><td>${s.address ?? DASH}</td></tr>
<tr><th>種別</th><td>${i.kindLabel ?? DASH}</td></tr>
<tr><th>${unit ? "専有面積" : "土地面積"}</th><td>${area(unit ? s.floorArea : s.landArea)}</td></tr>
${!unit && s.floorArea !== null ? html`<tr><th>延床面積</th><td>${area(s.floorArea)}</td></tr>` : null}
<tr><th>築年</th><td>${built}</td></tr>
<tr><th>交通</th><td>${s.access ?? DASH}</td></tr>
<tr><th>坪単価(仕入)</th><td>${money(i.calc.profit.purchaseTsuboPrice)}</td></tr>
</table>`;
}

const SECTION_HTML: Record<BusinessSectionKey, (i: BusinessPlanDocInput) => SafeHtml> = {
  overview,
  purchase: ({ calc: c }) => html`<h2>仕入</h2><table>
${row("仕入価格(税込)", money(c.purchase.priceIncl))}
${row("うち建物消費税", money(c.purchase.buildingTax))}
${row("仕入価格(税抜)", money(c.purchase.priceExcl))}
</table>`,
  acquisition: ({ calc: c }) => html`<h2>取得経費</h2><table>${lineRows(c.acquisition.lines)}${row("取得経費の合計", money(c.acquisition.total), true)}</table>`,
  renovation: ({ calc: c }) => html`<h2>改装・工事</h2><table>${lineRows(c.renovation.lines)}${row("改装・工事の合計", money(c.renovation.total), true)}</table>`,
  holding: ({ calc: c, inputs }) => html`<h2>保有コスト</h2><table>
${row("事業期間", c.holding.days === null ? DASH : `${c.holding.days}日`)}
${row(`借入金利息(年${(inputs.loanRateBp / 100).toFixed(2)}%)`, money(c.holding.interest))}
${row("固都税", money(c.holding.propertyTax))}
${c.holding.management ? row("管理費・修繕積立金など", money(c.holding.management)) : null}
${row("保有コストの合計", money(c.holding.total), true)}
</table>`,
  sale: ({ calc: c }) => html`<h2>販売</h2><table>
${row("売却価格(税込)", money(c.sale.priceIncl))}
${row("うち建物消費税", money(c.sale.buildingTax))}
${row("売却価格(税抜)", money(c.sale.priceExcl))}
${lineRows(c.sale.lines)}
${row("販売の費用の合計", money(c.sale.total), true)}
</table>`,
  profit: ({ calc: c }) => html`<h2>収支</h2><table>
${row("売上", money(c.profit.revenue))}
${row("経費合計", money(c.profit.costTotal))}
${row("粗利", money(c.profit.gross), true)}
${row("利益率", percent(c.profit.marginBp), true)}
${row("損益分岐の販売価格", money(c.profit.breakEven))}
${row("坪単価(仕入)", money(c.profit.purchaseTsuboPrice))}
${row("坪単価(販売)", money(c.profit.saleTsuboPrice))}
</table>
<ul class="notes"><li>損益分岐の販売価格は、販売の費用を今の売却価格のときの額で計算しています。</li></ul>`,
  financing: ({ calc: c }) => html`<h2>資金計画</h2><table>
${row("自己資金", money(c.financing.ownFunds))}
${row("借入額", money(c.financing.loanAmount))}
${row("借入期間", c.financing.loanMonths === null ? DASH : `${c.financing.loanMonths}か月`)}
${row("返済方法", REPAYMENT_LABELS[c.financing.repayment])}
</table>`,
  oc: ({ calc: c }) => {
    const o = c.oc;
    if (!o) return html``;
    return html`<h2>OC収支</h2><table>
${row("年間の賃料収入", money(o.annualIncome))}
${row("表面利回り", percent(o.grossYieldBp))}
${row("年間の運営費", money(o.annualExpenses))}
${row("NOI", money(o.noi))}
${row("NET利回り", percent(o.netYieldBp))}
${row("入居者の状況", `${o.rooms}室中 ${o.occupied}室入居${o.arrearsRooms ? `・滞納 ${o.arrearsRooms}室(${yen(o.arrearsAmount)}円)` : ""}`)}
</table>`;
  },
  evidence: ({ inputs }) => html`<h2>販売価格の根拠</h2>${inputs.comparables.length ? html`<table>
<tr><th>区分</th><th>物件</th><th class="num">面積</th><th class="num">価格</th><th>時期</th><th>メモ</th></tr>
${inputs.comparables.map((r) => html`<tr><td>${COMPARABLE_KIND_LABELS[r.kind]}</td><td>${r.name ?? DASH}</td><td class="num">${area(r.area)}</td><td class="num">${money(r.price)}</td><td>${r.period ?? DASH}</td><td>${r.note ?? ""}</td></tr>`)}
</table>` : html`<p>${DASH}</p>`}`,
};

/** 承認欄(社内用だけ)。押印のため空欄の枠。 */
const approvals = () => html`<table class="approvals" style="width:auto;margin-left:auto">
<tr><th>担当</th><th>上長</th><th>決裁者</th></tr>
<tr><td style="width:22mm;height:18mm"></td><td style="width:22mm"></td><td style="width:22mm"></td></tr>
</table>`;

/** 事業計画書(依頼書 4.2)の HTML。画面のプレビューと PDF で同じものを使う。 */
export function renderBusinessPlanHtml(i: BusinessPlanDocInput): string {
  const internal = i.inputs.variant === "internal";
  const title = `事業計画書(${BUSINESS_VARIANT_LABELS[i.inputs.variant]})`;
  return documentHtml({
    title,
    body: html`
<h1>${title}</h1>
<div class="meta">
<div>取引番号 ${i.deal.dealNo}</div>
<div class="right">作成日 ${dateJa(i.issuedOn)}</div>
</div>
${internal ? approvals() : null}
${i.sections.map((s) => SECTION_HTML[s](i))}
${internal && i.inputs.memo ? html`<h2>社内メモ</h2><p class="remarks">${i.inputs.memo}</p>` : null}
${companyBlock(i.company, i.logo)}`,
  });
}

/** 取引・税率の表・設定・入力から、事業計画書の計算・出すセクション・HTML をまとめて作る(プレビュー・PDF・Excel で共通)。 */
export function buildBusinessPlan(a: {
  deal: DealView; rateRows: RateTableRow[]; kinds: PropertyKindDef[]; matrix: SectionMatrix; inputs: BusinessInputs;
  company: CompanyProfile; today: string; logo: string | null;
}): { calc: BusinessPlanCalc; sections: BusinessSectionKey[]; html: string } {
  const calc = businessPlanCalc(a.deal, computeDealCalc(a.deal, a.rateRows, a.kinds, a.today), a.inputs, a.rateRows);
  const sections = businessPlanSections(a.deal.propertyKind, a.kinds, a.deal.hasOc, a.inputs.variant, a.matrix);
  const kindLabel = a.kinds.find((k) => k.key === a.deal.propertyKind)?.label ?? null;
  return {
    calc, sections,
    html: renderBusinessPlanHtml({
      deal: a.deal, inputs: a.inputs, calc, sections, kindLabel, company: a.company, issuedOn: a.today, logo: a.logo,
    }),
  };
}
