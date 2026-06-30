// 売却DM 補助 CSV(外部分析・差し込み用)の列定義と行ビルダ(純関数)。
// route 側で sanitizeCsvCellForExcel + encodeCsv(BOM+CRLF) に通す前提のため、
// ここでは formula injection 対策・quoting は行わない(セル値を素直に組むだけ)。
export const SALE_DM_CSV_HEADERS = [
  "型",
  "デザイン",
  "トーン",
  "長さ",
  "訴求軸",
  "強さ",
  "宛名",
  "敬称",
  "郵便番号",
  "送付先住所",
  "状態",
  "本文",
] as const;

export type SaleDmCsvHeader = (typeof SALE_DM_CSV_HEADERS)[number];

export interface SaleDmCsvRecord {
  variantLabel: string;
  designTemplate: string;
  tone: string;
  length: string;
  appeal: string;
  strength: string;
  recipientName: string;
  honorific: string;
  recipientZip: string | null;
  recipientAddress: string | null;
  status: string;
  body: string;
}

// null/undefined は空文字に倒す("null" という文字列は決して出さない)。
function s(value: string | null | undefined): string {
  return value ?? "";
}

export function buildSaleDmCsvRow(
  record: SaleDmCsvRecord,
): Record<SaleDmCsvHeader, string> {
  return {
    型: s(record.variantLabel),
    デザイン: s(record.designTemplate),
    トーン: s(record.tone),
    長さ: s(record.length),
    訴求軸: s(record.appeal),
    強さ: s(record.strength),
    宛名: s(record.recipientName),
    敬称: s(record.honorific),
    郵便番号: s(record.recipientZip),
    送付先住所: s(record.recipientAddress),
    状態: s(record.status),
    本文: s(record.body),
  };
}
