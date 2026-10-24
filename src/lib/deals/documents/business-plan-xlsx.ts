import ExcelJS from "exceljs";
import type { CompanyProfile } from "@/lib/sales-sheet/company-profile-store";
import type { BusinessPlanCalc } from "../calc/business-plan";
import {
  BUSINESS_VARIANT_LABELS, COMPARABLE_KIND_LABELS, REPAYMENT_LABELS, type BusinessInputs,
} from "../business-schema";
import type { BusinessSectionKey } from "../business-sections";
import type { DealView } from "../view";
import { PERCENT, Writer, amountLines, sumOf, type XlsxValue } from "./xlsx-writer";

/**
 * 事業計画書の Excel(設計 §4.8・計画 段4後半の読み替え 1〜2)。出すセクションは画面・PDF と同じ。
 * 合計・税抜・借入金利息・経費合計・粗利・利益率・損益分岐・NOI・利回りは数式で入れ、結果としてサーバーの値を入れておく。
 * 割り算・率の掛け算は整数にしてから行う(小数のままだと割り切れる値が 1 つ下に切り捨てられる=最終レビュー)。
 * 固都税・管理費等の日割りは値(日数の端数の決まりはサーバーの1か所)。文字はすべて文字の値。
 */
export interface BusinessPlanXlsxInput {
  deal: DealView;
  inputs: BusinessInputs;
  calc: BusinessPlanCalc;
  sections: BusinessSectionKey[];
  company: CompanyProfile;
  issuedOn: string;
  kindLabel?: string | null;
}

const SHEET = "事業計画書";
const f = (formula: string, result: number): XlsxValue => ({ formula, result });

export async function buildBusinessPlanXlsx(i: BusinessPlanXlsxInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = i.company.nameJa;
  wb.calcProperties.fullCalcOnLoad = true;
  const ws = wb.addWorksheet(SHEET, { pageSetup: { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  ws.getColumn(1).width = 34;
  for (let col = 2; col <= 6; col++) ws.getColumn(col).width = 16;

  const c = i.calc;
  const has = (s: BusinessSectionKey) => i.sections.includes(s);
  const internal = i.inputs.variant === "internal";
  const title = ws.getCell("A1");
  title.value = `事業計画書(${BUSINESS_VARIANT_LABELS[i.inputs.variant]})`;
  title.font = { bold: true, size: 16 };
  const w = new Writer(ws);
  w.row = 2;
  w.text(`取引番号 ${i.deal.dealNo}`);
  w.text(`作成日 ${i.issuedOn}`);
  if (internal) {
    // 承認欄(押印のため、名前の下は空欄)。
    const r = w.row++;
    ["担当", "上長", "決裁者"].forEach((label, idx) => {
      const cell = ws.getCell(r, 2 + idx);
      cell.value = label;
      cell.font = { bold: true };
      cell.border = { top: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" }, bottom: { style: "thin" } };
      ws.getCell(r + 1, 2 + idx).border = { left: { style: "thin" }, right: { style: "thin" }, bottom: { style: "thin" } };
    });
    ws.getRow(r + 1).height = 40;
    w.row++;
  }

  if (has("overview")) {
    const s = i.deal.propertySnapshot;
    const unit = c.kindBase === "unit";
    w.heading("物件概要");
    w.pair("物件名", [s.buildingName, s.roomNo].filter(Boolean).join(" "));
    w.pair("所在", s.address ?? "");
    w.pair("種別", i.kindLabel ?? "");
    w.pair(unit ? "専有面積(㎡)" : "土地面積(㎡)", String((unit ? s.floorArea : s.landArea) ?? ""));
    w.pair("築年", s.builtYear ? `${s.builtYear}年${s.builtMonth ? `${s.builtMonth}月` : ""}` : "");
    w.pair("交通", s.access ?? "");
  }

  // 仕入価格は経費合計の数式でいつも使う(仕入を出さないときは数式に値で入れる)。
  let priceRef: string | null = null;
  if (has("purchase")) {
    w.heading("仕入");
    const incl = w.line("仕入価格(税込)", c.purchase.priceIncl);
    const tax = w.line("仕入の建物消費税", c.purchase.buildingTax);
    w.line("仕入価格(税抜)", c.purchase.priceExcl === null ? null : f(`B${incl}-B${tax}`, c.purchase.priceExcl));
    priceRef = `B${incl}`;
  }

  const totals: string[] = [];
  let acquisitionRef: string | null = null;
  if (has("acquisition")) {
    w.heading("取得経費");
    const range = amountLines(w, c.acquisition.lines);
    acquisitionRef = `B${w.line("取得経費の合計", sumOf(range, c.acquisition.total), { bold: true })}`;
    totals.push(acquisitionRef);
  }
  if (has("renovation")) {
    w.heading("改装・工事");
    const range = amountLines(w, c.renovation.lines);
    totals.push(`B${w.line("改装・工事の合計", sumOf(range, c.renovation.total), { bold: true })}`);
  }
  if (has("holding")) {
    const h = c.holding;
    w.heading("保有コスト");
    const days = w.line("事業期間(日)", h.days, { numFmt: "0" });
    const loan = w.line("借入額", i.inputs.loanAmount ?? 0);
    const rate = w.line("借入金利(年)", i.inputs.loanRateBp / 10000, { numFmt: PERCENT });
    const first = w.line("借入金利息", h.days === null ? 0 : f(`ROUNDDOWN(B${loan}*ROUND(B${rate}*10000,0)*B${days}/3650000,0)`, h.interest));
    w.line("固都税(日割り)", h.propertyTax);
    const last = w.line("管理費・修繕積立金など(日割り)", h.management);
    totals.push(`B${w.line("保有コストの合計", f(`SUM(B${first}:B${last})`, h.total), { bold: true })}`);
  }
  let saleRef: string | null = null;
  if (has("sale")) {
    w.heading("販売");
    const incl = w.line("売却価格(税込)", c.sale.priceIncl);
    const tax = w.line("販売の建物消費税", c.sale.buildingTax);
    w.line("売却価格(税抜)", c.sale.priceExcl === null ? null : f(`B${incl}-B${tax}`, c.sale.priceExcl));
    const range = amountLines(w, c.sale.lines);
    totals.push(`B${w.line("販売の費用の合計", sumOf(range, c.sale.total), { bold: true })}`);
    saleRef = `B${incl}`;
  }

  if (has("profit")) {
    const p = c.profit;
    w.heading("収支");
    const revenue = w.line("売上", saleRef && p.revenue !== null ? f(saleRef, p.revenue) : p.revenue);
    const costFormula = [priceRef ?? String(c.purchase.priceIncl ?? 0), ...totals].join("+");
    const cost = w.line("経費合計", f(costFormula, p.costTotal), { bold: true });
    const gross = w.line("粗利", p.gross === null ? null : f(`B${revenue}-B${cost}`, p.gross), { bold: true });
    w.line("利益率", p.marginBp === null ? null : f(`TRUNC(B${gross}*10000/B${revenue})/10000`, p.marginBp / 10000), { bold: true, numFmt: PERCENT });
    w.line("損益分岐の販売価格", f(`B${cost}`, p.breakEven));
    w.line("坪単価(仕入)", p.purchaseTsuboPrice);
    w.line("坪単価(販売)", p.saleTsuboPrice);
    w.text("※損益分岐の販売価格は、販売の費用を今の売却価格のときの額で計算しています。");
  }

  if (has("financing")) {
    const fi = c.financing;
    w.heading("資金計画");
    w.line("自己資金", fi.ownFunds);
    w.line("借入額(資金計画)", fi.loanAmount);
    w.line("借入期間(か月)", fi.loanMonths, { numFmt: "0" });
    w.pair("返済方法", REPAYMENT_LABELS[fi.repayment]);
  }

  if (has("oc") && c.oc) {
    const o = c.oc;
    const price = c.purchase.priceIncl;
    w.heading("OC収支");
    const income = w.line("年間の賃料収入", o.annualIncome);
    const priceCell = priceRef ?? (price === null ? null : String(price));
    w.line("表面利回り", o.grossYieldBp === null || priceCell === null ? null : f(`TRUNC(B${income}*10000/${priceCell})/10000`, o.grossYieldBp / 10000), { numFmt: PERCENT });
    const expenses = w.line("年間の運営費", o.annualExpenses);
    const noi = w.line("NOI", f(`B${income}-B${expenses}`, o.noi), { bold: true });
    const base = priceCell === null ? null : `(${priceCell}+${acquisitionRef ?? c.acquisition.total})`;
    w.line("NET利回り", o.netYieldBp === null || base === null ? null : f(`TRUNC(B${noi}*10000/${base})/10000`, o.netYieldBp / 10000), { numFmt: PERCENT });
    w.pair("入居者の状況", `${o.rooms}室中 ${o.occupied}室入居${o.arrearsRooms ? `・滞納 ${o.arrearsRooms}室(${o.arrearsAmount}円)` : ""}`);
  }

  if (has("evidence")) {
    w.heading("販売価格の根拠");
    const head = w.row++;
    ["区分", "物件", "面積(㎡)", "価格", "時期", "メモ"].forEach((t, idx) => {
      const cell = ws.getCell(head, 1 + idx);
      cell.value = t;
      cell.font = { bold: true };
    });
    for (const r of i.inputs.comparables) {
      const row = w.row++;
      ws.getCell(row, 1).value = COMPARABLE_KIND_LABELS[r.kind];
      ws.getCell(row, 2).value = r.name ?? "";
      ws.getCell(row, 3).value = r.area;
      const price = ws.getCell(row, 4);
      price.value = r.price;
      price.numFmt = "#,##0";
      ws.getCell(row, 5).value = r.period ?? "";
      ws.getCell(row, 6).value = r.note ?? "";
    }
  }

  if (internal && i.inputs.memo) {
    w.heading("社内メモ");
    for (const line of i.inputs.memo.split(/\r?\n/)) w.text(line);
  }

  w.row++;
  w.text(i.company.nameJa);
  if (i.company.license) w.text(i.company.license);
  if (i.company.address) w.text(i.company.address);
  const tel = [i.company.tel && `TEL ${i.company.tel}`, i.company.fax && `FAX ${i.company.fax}`].filter(Boolean).join(" / ");
  if (tel) w.text(tel);

  return Buffer.from(await wb.xlsx.writeBuffer());
}
