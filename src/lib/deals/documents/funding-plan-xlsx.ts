import ExcelJS from "exceljs";
import type { FundingLine } from "../calc/funding-plan";
import type { FundingPlanDocInput } from "./funding-plan";

/**
 * 資金計画表の Excel(設計 §4.8)。合計・自己資金・手取り・月返済額は Excel の数式で入れ、
 * どの数式のセルにもサーバーで計算した値を結果として入れておく(開いた直後の表示と、テストの照合用)。
 * 月返済額は `=ROUNDDOWN(PMT(年利/12,年数*12,-借入額),0)`(サーバーの loanPayment と同じ切り捨て)。
 * 文字はすべて文字の値として入れる(お客様名などが数式として読まれない)。
 */

const YEN = "#,##0";
const SHEET = "資金計画表";

type Cell = ExcelJS.Cell;

class Writer {
  row = 1;
  constructor(readonly ws: ExcelJS.Worksheet) {}

  /** 見出し(A列だけ・太字)。 */
  heading(text: string) {
    this.row++;
    const c = this.ws.getCell(`A${this.row}`);
    c.value = text;
    c.font = { bold: true, size: 12 };
    this.row++;
  }

  /** ラベルと値(または数式)の1行。行番号を返す。 */
  line(label: string, value: number | null | { formula: string; result: number }, opts: { bold?: boolean } = {}): number {
    const r = this.row++;
    this.ws.getCell(`A${r}`).value = label;
    const b: Cell = this.ws.getCell(`B${r}`);
    b.value = value;
    b.numFmt = YEN;
    if (opts.bold) {
      this.ws.getCell(`A${r}`).font = { bold: true };
      b.font = { bold: true };
    }
    return r;
  }

  text(t: string) {
    this.ws.getCell(`A${this.row++}`).value = t;
  }
}

/** 金額のある行だけを並べ、最初と最後の行番号を返す(1行も無ければ null)。 */
function amountLines(w: Writer, lines: FundingLine[]): { first: number; last: number } | null {
  const shown = lines.filter((l) => l.amount !== null);
  if (!shown.length) return null;
  const first = w.row;
  for (const l of shown) w.line(l.label, l.amount);
  return { first, last: w.row - 1 };
}

const sumOf = (range: { first: number; last: number } | null, result: number) =>
  range ? { formula: `SUM(B${range.first}:B${range.last})`, result } : 0;

function purchaseSheet(w: Writer, i: FundingPlanDocInput) {
  const c = i.calc;
  const p = c.purchase;
  w.heading("物件価格と諸費用");
  const priceRow = w.line("物件価格", c.price);
  const range = amountLines(w, p.lines);
  const costsRow = w.line("諸費用の合計", sumOf(range, p.costsTotal), { bold: true });
  // 価格が無いときは合計・自己資金を出さない(サーバーの計算も null)。
  const totalRow = c.price === null || p.total === null
    ? w.line("必要な資金の合計", null, { bold: true })
    : w.line("必要な資金の合計", { formula: `B${priceRow}+B${costsRow}`, result: p.total }, { bold: true });

  w.heading("資金の内訳");
  const loanRow = w.line("借入額", p.loanAmount);
  w.line("自己資金", p.ownFunds === null ? null : { formula: `B${totalRow}-B${loanRow}`, result: p.ownFunds });

  if (p.loans.length) {
    w.heading("ローンの比較(元利均等返済)");
    const head = w.row++;
    const rateRow = w.row++;
    const yearsRow = w.row++;
    const monthlyRow = w.row++;
    w.ws.getCell(`A${rateRow}`).value = "金利(年)";
    w.ws.getCell(`A${yearsRow}`).value = "返済期間(年)";
    w.ws.getCell(`A${monthlyRow}`).value = "月々の返済額";
    const housing = p.monthlyHousing !== null;
    const housingRow = housing ? w.row++ : 0;
    const totalMonthlyRow = housing ? w.row++ : 0;
    if (housing) {
      w.ws.getCell(`A${housingRow}`).value = "管理費・修繕積立金など(月額)";
      w.ws.getCell(`A${totalMonthlyRow}`).value = "月々のお支払いの合計";
      w.ws.getCell(`A${totalMonthlyRow}`).font = { bold: true };
    }
    p.loans.forEach((l, idx) => {
      const col = String.fromCharCode("B".charCodeAt(0) + idx);
      w.ws.getCell(`${col}${head}`).value = `パターン${idx + 1}`;
      w.ws.getCell(`${col}${head}`).font = { bold: true };
      const rate = w.ws.getCell(`${col}${rateRow}`);
      rate.value = l.annualRateBp / 10000;
      rate.numFmt = "0.000%";
      w.ws.getCell(`${col}${yearsRow}`).value = l.years;
      const m = w.ws.getCell(`${col}${monthlyRow}`);
      m.value = { formula: `ROUNDDOWN(PMT(${col}${rateRow}/12,${col}${yearsRow}*12,-$B$${loanRow}),0)`, result: l.monthly };
      m.numFmt = YEN;
      if (housing) {
        const h = w.ws.getCell(`${col}${housingRow}`);
        h.value = p.monthlyHousing;
        h.numFmt = YEN;
        const t = w.ws.getCell(`${col}${totalMonthlyRow}`);
        t.value = { formula: `${col}${monthlyRow}+${col}${housingRow}`, result: l.monthlyTotal };
        t.numFmt = YEN;
        t.font = { bold: true };
      }
    });
  }
  if (p.notes.length) {
    w.row++;
    for (const n of p.notes) w.text(`※${n}`);
  }
}

function saleSheet(w: Writer, i: FundingPlanDocInput) {
  const c = i.calc;
  const s = c.sale;
  w.heading("売却価格と費用");
  const priceRow = w.line("売却価格", c.price);
  const range = amountLines(w, s.lines);
  const costsRow = w.line("費用の合計", sumOf(range, s.costsTotal), { bold: true });
  const loanRow = w.line("ローン残債", s.loanBalance);
  const settleRow = w.line("精算金(固都税・管理費など)", s.settlementReceive);
  const depositRow = w.line("預り敷金の承継(残代金と相殺)", s.depositOffset);
  const netRow = s.netBeforeTax === null
    ? w.line("手取り額(税引前)", null, { bold: true })
    : w.line("手取り額(税引前)", {
      formula: `B${priceRow}-B${costsRow}-B${loanRow}+B${settleRow}-B${depositRow}`, result: s.netBeforeTax,
    }, { bold: true });

  if (s.tax) {
    const t = s.tax;
    w.heading("譲渡所得税の目安");
    w.line(`取得費${t.usedEstimatedCost ? "(不明のため売却価格の5%)" : ""}`, t.acquisitionCost);
    w.line("譲渡所得", t.gain);
    if (t.deduction) w.line("特別控除(居住用)", t.deduction);
    w.line(`課税される譲渡所得(${t.longTerm ? "長期" : "短期"})`, t.taxable);
    w.line("所得税", t.incomeTax);
    w.line("復興特別所得税", t.reconstructionTax);
    w.line("住民税", t.residentTax);
    const taxRow = w.line("税額の合計(目安)", t.total, { bold: true });
    if (s.netAfterTax !== null) {
      w.line("税引後の手取り額(目安)", { formula: `B${netRow}-B${taxRow}`, result: s.netAfterTax }, { bold: true });
    }
  }
  w.row++;
  for (const n of [s.taxNote, ...s.notes]) w.text(`※${n}`);
}

export async function buildFundingPlanXlsx(i: FundingPlanDocInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = i.company.nameJa;
  // 開いたときに数式を計算し直させる(入れておいた結果は、計算し直す前の表示に使われる)。
  wb.calcProperties.fullCalcOnLoad = true;
  const ws = wb.addWorksheet(SHEET, { pageSetup: { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  ws.getColumn(1).width = 36;
  for (let col = 2; col <= 4; col++) ws.getColumn(col).width = 18;

  const purchase = i.calc.mode === "purchase";
  const title = ws.getCell("A1");
  title.value = `資金計画表(${purchase ? "ご購入" : "ご売却"})`;
  title.font = { bold: true, size: 16 };
  const w = new Writer(ws);
  w.row = 2;
  w.text(`${i.inputs.customerName ?? ""} 様`);
  w.text(`作成日 ${i.issuedOn}`);
  const snap = i.deal.propertySnapshot;
  const name = [snap.buildingName, snap.roomNo].filter(Boolean).join(" ");
  if (name) w.text(`物件名 ${name}`);
  if (snap.address) w.text(`所在 ${snap.address}`);
  // 取引の設定の文面は1行ずつ文字として入れる(数式にならない)。ロゴは Excel には入れない(計画の読み替え 5)。
  const textLines = (t: string | null | undefined) => {
    if (!t) return;
    w.row++;
    for (const line of t.split(/\r?\n/)) w.text(line);
  };
  textLines(i.text?.greeting);

  if (purchase) purchaseSheet(w, i);
  else saleSheet(w, i);

  textLines(i.text?.notes);
  w.row++;
  w.text(i.company.nameJa);
  if (i.company.license) w.text(i.company.license);
  if (i.company.address) w.text(i.company.address);
  const tel = [i.company.tel && `TEL ${i.company.tel}`, i.company.fax && `FAX ${i.company.fax}`].filter(Boolean).join(" / ");
  if (tel) w.text(tel);

  return Buffer.from(await wb.xlsx.writeBuffer());
}
