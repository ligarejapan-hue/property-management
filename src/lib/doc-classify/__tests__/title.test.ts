import { describe, it, expect } from "vitest";
import {
  buildDocTitle,
  dateStampFromDocTitle,
  extractDocumentDate,
  fileExtension,
  propertyLabelForTitle,
  uniqueDocTitle,
} from "../title";
import { defaultOpenStage } from "../stage";

describe("propertyLabelForTitle", () => {
  it("物件名+号室(号室の語と空白を除く)", () => {
    expect(propertyLabelForTitle({ buildingName: "ハマイハイライズ", roomNo: "305号室", address: "x" })).toBe("ハマイハイライズ305");
    expect(propertyLabelForTitle({ buildingName: "西荻リリエンハイム", roomNo: "４０７", address: "x" })).toBe("西荻リリエンハイム407");
  });
  it("物件名が無ければ所在地(郵便番号と空白を除く)", () => {
    expect(propertyLabelForTitle({ buildingName: null, roomNo: null, address: "〒270-0161 千葉県流山市鰭ヶ崎2丁目 123-4" })).toBe("千葉県流山市鰭ヶ崎2丁目123-4");
  });
  it("物件名があれば号室が無くてもよい", () => {
    expect(propertyLabelForTitle({ buildingName: "千早ハイツ", roomNo: null, address: "x" })).toBe("千早ハイツ");
  });
});

describe("fileExtension", () => {
  it("小文字の拡張子・無ければ null", () => {
    expect(fileExtension("a.PDF")).toBe("pdf");
    expect(fileExtension("写真.jpeg")).toBe("jpeg");
    expect(fileExtension("noext")).toBeNull();
    expect(fileExtension(".hidden")).toBeNull();
  });
});

describe("buildDocTitle", () => {
  it("種類_物件名号室_YYYYMMDD.拡張子", () => {
    expect(
      buildDocTitle({ kindLabel: "売買契約書", propertyLabel: "ハマイハイライズ305", date: new Date(Date.UTC(2026, 9, 23)), ext: "pdf" }),
    ).toBe("売買契約書_ハマイハイライズ305_20261023.pdf");
  });
  it("ファイル名に使えない文字は _ に", () => {
    expect(
      buildDocTitle({ kindLabel: "領収書(残代金・仲介手数料)", propertyLabel: "A/B:C", date: new Date(Date.UTC(2026, 0, 5)), ext: "pdf" }),
    ).toBe("領収書(残代金・仲介手数料)_A_B_C_20260105.pdf");
  });
  it("拡張子が無ければ付けない", () => {
    expect(buildDocTitle({ kindLabel: "x", propertyLabel: "y", date: new Date(Date.UTC(2026, 0, 5)), ext: null })).toBe("x_y_20260105");
  });
});

describe("uniqueDocTitle", () => {
  it("同じ名前があれば _2・_3 を付ける", () => {
    const taken = new Set(["a_b_20260105.pdf", "a_b_20260105_2.pdf"]);
    expect(uniqueDocTitle("a_b_20260105.pdf", taken)).toBe("a_b_20260105_3.pdf");
    expect(uniqueDocTitle("c.pdf", taken)).toBe("c.pdf");
    expect(uniqueDocTitle("noext", new Set(["noext"]))).toBe("noext_2");
  });
});

describe("dateStampFromDocTitle", () => {
  it("名前の末尾の日付を取り出す(連番つきも)", () => {
    expect(dateStampFromDocTitle("売買契約書_X_20261023.pdf")).toBe("20261023");
    expect(dateStampFromDocTitle("売買契約書_X_20261023_2.pdf")).toBe("20261023");
    expect(dateStampFromDocTitle("x.pdf")).toBeNull();
    expect(dateStampFromDocTitle(null)).toBeNull();
  });
});

describe("extractDocumentDate", () => {
  it("西暦の日付", () => {
    expect(extractDocumentDate("契約日 2026年10月23日 …")).toBe("20261023");
    expect(extractDocumentDate("2026年1月5日")).toBe("20260105");
  });
  it("元号の日付(令和・平成)", () => {
    expect(extractDocumentDate("令和8年10月23日")).toBe("20261023");
    expect(extractDocumentDate("令和元年5月1日")).toBe("20190501");
    expect(extractDocumentDate("平成31年4月30日")).toBe("20190430");
  });
  it("全角の数字も読む", () => {
    expect(extractDocumentDate("令和８年１０月２３日")).toBe("20261023");
  });
  it("暦に無い日付・無いときは null", () => {
    expect(extractDocumentDate("2026年2月30日")).toBeNull();
    expect(extractDocumentDate("日付なし")).toBeNull();
    expect(extractDocumentDate(undefined)).toBeNull();
  });
  it("先頭 3,000 文字の外は見ない", () => {
    expect(extractDocumentDate(`${"x".repeat(3000)}2026年10月23日`)).toBeNull();
  });
});

describe("defaultOpenStage", () => {
  it("契約予定→②・契約完了/決済完了→③・それ以外→①", () => {
    expect(defaultOpenStage("contract_planned")).toBe("contract");
    expect(defaultOpenStage("contracted")).toBe("settlement");
    expect(defaultOpenStage("sold")).toBe("settlement");
    expect(defaultOpenStage("on_sale")).toBe("pre_contract");
    expect(defaultOpenStage(null)).toBe("pre_contract");
  });
});
