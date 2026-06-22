import { describe, it, expect } from "vitest";
import {
  SALE_DM_CSV_HEADERS,
  buildSaleDmCsvRow,
  type SaleDmCsvRecord,
} from "../sale-dm-letter/csv";

const record: SaleDmCsvRecord = {
  variantLabel: "A",
  designTemplate: "formal",
  tone: "formal",
  length: "medium",
  appeal: "price",
  strength: "low",
  recipientName: "田中 一郎",
  honorific: "様",
  recipientZip: "100-0001",
  recipientAddress: "東京都〇〇区△△1-2-3",
  status: "confirmed",
  body: "拝啓\n本文2行目",
};

describe("SALE_DM_CSV_HEADERS", () => {
  it("設定一式・宛名・本文の列を含む", () => {
    for (const h of ["型", "デザイン", "トーン", "長さ", "訴求軸", "強さ", "宛名", "敬称", "郵便番号", "送付先住所", "状態", "本文"]) {
      expect(SALE_DM_CSV_HEADERS).toContain(h);
    }
  });
});

describe("buildSaleDmCsvRow", () => {
  it("各列に対応する値を入れる(本文は1セル)", () => {
    const row = buildSaleDmCsvRow(record);
    expect(row["型"]).toBe("A");
    expect(row["デザイン"]).toBe("formal");
    expect(row["宛名"]).toBe("田中 一郎");
    expect(row["敬称"]).toBe("様");
    expect(row["郵便番号"]).toBe("100-0001");
    expect(row["送付先住所"]).toBe("東京都〇〇区△△1-2-3");
    expect(row["状態"]).toBe("confirmed");
    expect(row["本文"]).toBe("拝啓\n本文2行目");
  });

  it("null フィールドは空文字", () => {
    const row = buildSaleDmCsvRow({ ...record, recipientZip: null, recipientAddress: null });
    expect(row["郵便番号"]).toBe("");
    expect(row["送付先住所"]).toBe("");
  });

  it("全ヘッダのキーが存在する(欠けセルなし)", () => {
    const row = buildSaleDmCsvRow(record);
    for (const h of SALE_DM_CSV_HEADERS) {
      expect(Object.prototype.hasOwnProperty.call(row, h)).toBe(true);
    }
  });
});
