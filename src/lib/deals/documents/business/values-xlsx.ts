import ExcelJS from "exceljs";
import { YEN } from "../xlsx-writer";
import type { ValueRow } from "./common";

/**
 * 業務書類の Excel(値だけ・設計 §4.8)。A列=項目・B列=値。文字は文字のまま(数式として読まれない)。
 * issuerName = その書類を出す人(個人の売主の領収書では、その人の名前=自社の名前は入れない・最終レビュー)。
 */
export async function buildValuesXlsx(a: { title: string; dealNo: string; issuedOn: string; rows: ValueRow[]; issuerName: string }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = a.issuerName;
  const ws = wb.addWorksheet(a.title.slice(0, 31), { pageSetup: { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  ws.getColumn(1).width = 34;
  ws.getColumn(2).width = 48;
  const t = ws.getCell("A1");
  t.value = a.title;
  t.font = { bold: true, size: 16 };
  ws.getCell("A2").value = `取引番号 ${a.dealNo}`;
  ws.getCell("A3").value = `作成日 ${a.issuedOn}`;
  let r = 5;
  for (const row of a.rows) {
    const label = ws.getCell(`A${r}`);
    label.value = row.label;
    if (row.heading) {
      label.font = { bold: true };
    } else {
      const v = ws.getCell(`B${r}`);
      v.value = row.value ?? null;
      if (typeof row.value === "number") v.numFmt = YEN;
      if (typeof row.value === "string") v.alignment = { wrapText: true, vertical: "top" };
    }
    r++;
  }
  ws.getCell(`A${r + 1}`).value = a.issuerName;
  return Buffer.from(await wb.xlsx.writeBuffer());
}
