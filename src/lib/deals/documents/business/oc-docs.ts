import { z } from "zod";
import { isoDate, text } from "../../schema-parts";
import { businessPlanCalc } from "../../calc/business-plan";
import { jstDateString } from "../../datetime";
import type { Lease } from "../../schemas";
import { html, type SafeHtml } from "../html";
import { companyBlock, documentHtml } from "../layout";
import {
  DASH, LEASE_CONTRACT_LABELS, bankAccountText, dateJa, headTable, money, namesOf, partiesOf, propertyLabel, signBox,
  type BusinessDocContext, type ValueRow,
} from "./common";

/** OC ありの取引だけに出す4種(依頼書 4.3・計画の読み替え 3〜6)。 */

const percent = (bp: number | null) => (bp === null ? DASH : `${(bp / 100).toFixed(2)}%`);
const roomOf = (l: Lease, i: number) => l.room ?? `${i + 1}件目`;
const monthly = (l: Lease) => l.rent + l.commonFee + l.parking + l.other;
/** 賃借人のいる行(空室は除く)。 */
export const occupiedLeases = (c: BusinessDocContext) => c.deal.leases.map((l, i) => ({ l, i })).filter(({ l }) => l.tenant);

// ---- 仕入相談表 ----

/** 仕入相談表。利回り・NOI は事業計画書と同じ計算。賃借人の名前は出さない(計画の読み替え 3)。 */
export function buildOcPurchaseConsult(c: BusinessDocContext): { html: string; rows: ValueRow[] } {
  const d = c.deal;
  const oc = businessPlanCalc(d, c.calc, d.businessPlan, c.rateRows).oc ?? {
    annualIncome: 0, grossYieldBp: null, annualExpenses: 0, noi: 0, netYieldBp: null, rooms: 0, occupied: 0, arrearsRooms: 0, arrearsAmount: 0,
  };
  const monthlyTotal = d.leases.reduce((a, l) => a + monthly(l), 0);
  const expenseNote = d.businessPlan.ocAnnualExpenses === null ? "(固都税+管理費の目安)" : "";
  const body = html`
<h1>仕入相談表</h1>
<div class="right">${dateJa(c.today)}</div>
${headTable([["取引番号", d.dealNo], ["物件", propertyLabel(d)], ["売買価格", money(d.price)]])}
<h2>部屋ごとの状況</h2>
<table>
<tr><th>部屋</th><th>状況</th><th>契約形態</th><th class="num">月額(賃料・共益費など)</th><th class="num">預り敷金</th><th>滞納</th></tr>
${d.leases.map((l, i) => html`<tr><td>${roomOf(l, i)}</td><td>${l.tenant ? "入居中" : "空室"}</td><td>${l.tenant ? LEASE_CONTRACT_LABELS[l.contractType] : DASH}</td>
<td class="num">${money(monthly(l))}</td><td class="num">${money(l.deposit)}</td><td>${l.arrears ? `あり ${money(l.arrearsAmount)}` : "なし"}</td></tr>`)}
</table>
<h2>収支</h2>
<table>
<tr><th style="width:50%">月額収入の合計</th><td class="num">${money(monthlyTotal)}</td></tr>
<tr><th>年間収入</th><td class="num">${money(oc.annualIncome)}</td></tr>
<tr><th>表面利回り</th><td class="num">${percent(oc.grossYieldBp)}</td></tr>
<tr><th>年間経費${expenseNote}</th><td class="num">${money(oc.annualExpenses)}</td></tr>
<tr class="total"><th>NOI(年)</th><td class="num">${money(oc.noi)}</td></tr>
<tr><th>NET利回り(取得費用込み)</th><td class="num">${percent(oc.netYieldBp)}</td></tr>
<tr><th>入居</th><td class="num">${oc.occupied}/${oc.rooms}室</td></tr>
<tr><th>滞納</th><td class="num">${oc.arrearsRooms}室 ${money(oc.arrearsAmount)}</td></tr>
</table>`;
  return {
    html: documentHtml({ title: "仕入相談表", body }),
    rows: [
      { label: "取引番号", value: d.dealNo }, { label: "物件", value: propertyLabel(d) }, { label: "売買価格", value: d.price },
      { label: "部屋ごとの状況", heading: true },
      ...d.leases.map((l, i) => ({ label: `${roomOf(l, i)}(${l.tenant ? "入居中" : "空室"})`, value: monthly(l) })),
      { label: "収支", heading: true },
      { label: "月額収入の合計", value: monthlyTotal }, { label: "年間収入", value: oc.annualIncome },
      { label: "表面利回り", value: percent(oc.grossYieldBp) }, { label: `年間経費${expenseNote}`, value: oc.annualExpenses },
      { label: "NOI(年)", value: oc.noi }, { label: "NET利回り(取得費用込み)", value: percent(oc.netYieldBp) },
      { label: "入居", value: `${oc.occupied}/${oc.rooms}室` }, { label: "滞納の金額", value: oc.arrearsAmount },
    ],
  };
}

// ---- 賃借人属性調査書 ----

const blank = "　";

/** 賃借人属性調査書。賃借人のいる部屋ごとに1つの欄。手で書く欄は空欄(計画の読み替え 4)。 */
export function buildTenantSurvey(c: BusinessDocContext): { html: string; rows: ValueRow[] } {
  const items = occupiedLeases(c);
  const section = ({ l, i }: { l: Lease; i: number }): SafeHtml => html`<div class="tenant" style="page-break-inside:avoid;margin-bottom:4mm">
<h2>${roomOf(l, i)}</h2>
<table>
<tr><th style="width:28%">賃借人</th><td>${l.tenant}</td><th style="width:18%">契約形態</th><td>${LEASE_CONTRACT_LABELS[l.contractType]}</td></tr>
<tr><th>契約期間</th><td>${l.period ?? DASH}</td><th>管理会社</th><td>${l.manager ?? DASH}</td></tr>
<tr><th>月額(賃料・共益費など)</th><td>${money(monthly(l))}</td><th>預り敷金</th><td>${money(l.deposit)}</td></tr>
<tr><th>滞納</th><td colspan="3">${l.arrears ? `あり ${money(l.arrearsAmount)}` : "なし"}</td></tr>
<tr><th>勤務先・職業</th><td colspan="3">${blank}</td></tr>
<tr><th>連絡先</th><td colspan="3">${blank}</td></tr>
<tr><th>連帯保証人・保証会社</th><td colspan="3">${blank}</td></tr>
<tr><th>入居人数</th><td colspan="3">${blank}</td></tr>
<tr><th>反社会的勢力の確認</th><td colspan="3">□該当なし　□要確認　(確認日　　年　　月　　日　確認者　　　　　　)</td></tr>
<tr><th>備考</th><td colspan="3" style="height:12mm">${blank}</td></tr>
</table></div>`;
  const body = html`
<h1>賃借人属性調査書</h1>
<div class="right">${dateJa(c.today)}</div>
${headTable([["取引番号", c.deal.dealNo], ["物件", propertyLabel(c.deal)]])}
${items.map(section)}`;
  return {
    html: documentHtml({ title: "賃借人属性調査書", body }),
    rows: [
      { label: "取引番号", value: c.deal.dealNo }, { label: "物件", value: propertyLabel(c.deal) },
      ...items.flatMap(({ l, i }) => [
        { label: roomOf(l, i), heading: true },
        { label: "賃借人", value: l.tenant }, { label: "契約形態", value: LEASE_CONTRACT_LABELS[l.contractType] },
        { label: "契約期間", value: l.period }, { label: "月額", value: monthly(l) }, { label: "預り敷金", value: l.deposit },
        { label: "滞納", value: l.arrears ? l.arrearsAmount : "なし" }, { label: "管理会社", value: l.manager },
      ]),
    ],
  };
}

// ---- 賃貸人変更のお知らせ ----

export const landlordChangeOptionsSchema = z.object({ changeOn: isoDate.nullable(), payee: text(300) }).strict();
export type LandlordChangeOptions = z.output<typeof landlordChangeOptionsSchema>;

/** 初期値: 変更日=決済日(日本時間)・振込先は買主が自社なら設定の口座(計画の読み替え 5)。 */
export function landlordChangeDefaults(c: BusinessDocContext): LandlordChangeOptions {
  const self = partiesOf(c.deal, "buyer").some((p) => p.isSelf);
  return { changeOn: c.deal.settlementAt ? jstDateString(new Date(c.deal.settlementAt)) : null, payee: self ? bankAccountText(c) : null };
}

/** 賃貸人変更のお知らせ。賃借人のいる部屋ごとに1枚。売主・買主の連名で、押印の欄は空欄。 */
export function buildLandlordChangeNotice(c: BusinessDocContext, o: LandlordChangeOptions): { html: string; rows: ValueRow[] } {
  const d = c.deal;
  const sellers = partiesOf(d, "seller");
  const buyers = partiesOf(d, "buyer");
  const names = (ps: typeof sellers) => ps.map((p) => html`<div>${p.address ?? ""}　${p.name}</div>`);
  const changeOn = o.changeOn ? dateJa(o.changeOn) : "　　年　　月　　日";
  const page = ({ l, i }: { l: Lease; i: number }, n: number): SafeHtml => html`<div${n > 0 ? html` style="page-break-before:always"` : null}>
<h1>賃貸人変更のお知らせ</h1>
<div class="meta"><div class="customer">${roomOf(l, i)} ${l.tenant} 様</div><div class="right">${dateJa(c.today)}</div></div>
<p>平素は格別のご高配を賜り、厚く御礼申し上げます。</p>
<p>このたび、お借りいただいている下記の建物が売買されたことにより、賃貸人が次のとおり変わりますので、お知らせいたします。賃料・敷金などの賃貸借の条件は、そのまま新しい賃貸人に引き継がれます。</p>
${headTable([["物件", propertyLabel(d)], ["お部屋", roomOf(l, i)], ["変更日", changeOn], ["新しい賃貸人", namesOf(buyers)]])}
<h2>賃料のお振込先</h2>
<p>変更日以降にお支払い期日が来る賃料は、次の口座へお振り込みください。</p>
<p class="remarks" style="font-size:10pt">${o.payee ?? "(新しい賃貸人から、あらためてご案内いたします)"}</p>
<table style="margin-top:6mm">
<tr><th style="width:22%">旧賃貸人(売主)</th><td>${names(sellers)}</td><td style="width:22mm;text-align:center;color:#666">印</td></tr>
<tr><th>新賃貸人(買主)</th><td>${names(buyers)}</td><td style="text-align:center;color:#666">印</td></tr>
</table>
${companyBlock(c.company, c.logo)}
</div>`;
  const items = occupiedLeases(c);
  return {
    html: documentHtml({ title: "賃貸人変更のお知らせ", font: "mincho", body: items.map(page) }),
    rows: [
      { label: "物件", value: propertyLabel(d) }, { label: "変更日", value: o.changeOn },
      { label: "旧賃貸人(売主)", value: namesOf(sellers) }, { label: "新賃貸人(買主)", value: namesOf(buyers) },
      { label: "賃料のお振込先", value: o.payee },
      { label: "宛先", heading: true },
      ...items.map(({ l, i }) => ({ label: roomOf(l, i), value: l.tenant })),
    ],
  };
}

// ---- 引継書類チェックリスト ----

const DEPOSIT_MODE_LABELS = { offset: "残代金と相殺", separate: "別途授受" } as const;

/** 引継書類チェックリスト(計画の読み替え 6)。チェック欄は売主・買主の2列で空欄。 */
export function buildHandoverChecklist(c: BusinessDocContext): { html: string; rows: ValueRow[] } {
  const d = c.deal;
  const depositTotal = d.leases.reduce((a, l) => a + l.deposit, 0);
  const managers = [...new Set(d.leases.map((l) => l.manager).filter((m): m is string => !!m))].join("・") || null;
  const arrears = d.leases.filter((l) => l.arrears);
  const mode = DEPOSIT_MODE_LABELS[d.settlementTerms.depositMode];
  const roomRows: [string, string][] = occupiedLeases(c).flatMap(({ l, i }) => [
    [`${roomOf(l, i)} 賃貸借契約書(原本)`, l.tenant ?? ""],
    [`${roomOf(l, i)} 鍵`, "　　本"],
    [`${roomOf(l, i)} 敷金`, money(l.deposit)],
  ]);
  const general: [string, string][] = [
    ["管理会社への連絡", managers ?? DASH],
    ["敷金の引継ぎ", `${money(depositTotal)}(${mode})`],
    ["賃料の振込先の変更の通知", "賃貸人変更のお知らせ"],
    ["滞納の確認", arrears.length ? `${arrears.length}室 ${money(arrears.reduce((a, l) => a + l.arrearsAmount, 0))}` : "なし"],
    ["保証会社への連絡", "　"],
    ["重要事項説明書・付属書類(写し)", "　"],
  ];
  const tr = ([k, v]: [string, string]) => html`<tr><td>${k}</td><td>${v}</td><td style="text-align:center">□</td><td style="text-align:center">□</td></tr>`;
  const head = html`<tr><th>項目</th><th>内容</th><th style="width:14mm">売主</th><th style="width:14mm">買主</th></tr>`;
  const body = html`
<h1>引継書類チェックリスト</h1>
<div class="right">${dateJa(c.today)}</div>
${headTable([["取引番号", d.dealNo], ["物件", propertyLabel(d)], ["売主", namesOf(partiesOf(d, "seller"))], ["買主", namesOf(partiesOf(d, "buyer"))]])}
<h2>お部屋ごと</h2>
<table>${head}${roomRows.map(tr)}</table>
<h2>全体</h2>
<table>${head}${general.map(tr)}</table>
<table style="margin-top:6mm"><tr><th style="width:22%">確認日</th><td>　　年　　月　　日</td><th style="width:18%">確認者</th><td>　</td></tr></table>
${signBox("承認")}`;
  return {
    html: documentHtml({ title: "引継書類チェックリスト", body }),
    rows: [
      { label: "取引番号", value: d.dealNo }, { label: "物件", value: propertyLabel(d) },
      { label: "お部屋ごと", heading: true }, ...roomRows.map(([k, v]) => ({ label: k, value: v })),
      { label: "全体", heading: true }, ...general.map(([k, v]) => ({ label: k, value: v })),
      { label: "預り敷金の合計", value: depositTotal }, { label: "敷金の扱い", value: mode },
    ],
  };
}
