import { describe, expect, it } from "vitest";
import { dropFileKind, isHandoffTarget, pdfTarget, sheetTarget } from "../detect";

describe("dropFileKind", () => {
  it.each([
    [{ name: "受付帳.csv", type: "text/csv" }, "sheet"],
    [{ name: "a.TSV", type: "" }, "sheet"],
    [{ name: "a.txt", type: "text/plain" }, "sheet"],
    [{ name: "顧客管理表.xlsx", type: "" }, "sheet"],
    [{ name: "古い.xls", type: "" }, "other"],
    [{ name: "謄本.PDF", type: "" }, "pdf"],
    [{ name: "x", type: "application/pdf" }, "pdf"],
    [{ name: "契約書.docx", type: "" }, "other"],
    [{ name: "写真.jpg", type: "image/jpeg" }, "other"],
  ])("%o → %s", (file, kind) => {
    expect(dropFileKind(file)).toBe(kind);
  });
});

describe("sheetTarget(表の行き先)", () => {
  it("顧客管理表の行があれば、列の判定より先に Excelから物件化", () => {
    expect(sheetTarget({ contentType: "owner", leadRows: 3, isXlsx: true })).toBe("lead_excel");
  });

  it("受付帳・所有者は列の判定のとおり", () => {
    expect(sheetTarget({ contentType: "reception", leadRows: 0, isXlsx: false })).toBe("reception");
    expect(sheetTarget({ contentType: "owner", leadRows: 0, isXlsx: true })).toBe("owner");
  });

  it("決まらない Excel は書類(受け取り箱)・決まらない CSV は人が選ぶ", () => {
    expect(sheetTarget({ contentType: "unknown", leadRows: 0, isXlsx: true })).toBe("document");
    expect(sheetTarget({ contentType: "ambiguous", leadRows: 0, isXlsx: false })).toBe("unknown");
    expect(sheetTarget({ contentType: null, leadRows: 0, isXlsx: false })).toBe("unknown");
  });
});

describe("pdfTarget(PDF の行き先)", () => {
  it("謄本の見出しがあれば謄本の取り込み", () => {
    expect(pdfTarget("東京都練馬区氷川台4丁目162-2-710 全部事項証明書(建物)\n表題部")).toBe("registry_pdf");
    expect(pdfTarget("権 利 部 （ 甲 区 ） （ 所 有 権 に 関 す る 事 項 ）")).toBe("registry_pdf");
    expect(pdfTarget("東京都千代田区… 所 有 者 事 項\n所有者 …")).toBe("registry_pdf");
  });

  it("HOME4U・タカウルの反響は貼り付けて物件化", () => {
    expect(pdfTarget("査定ナンバー：123456\nお名前：…")).toBe("paste_pdf");
    expect(pdfTarget("空き家所有者との関係性：本人")).toBe("paste_pdf");
    expect(pdfTarget("査定物件の所在地：東京都…\nマンションレビューを見る")).toBe("paste_pdf");
  });

  it("「査定物件の所在地」だけでは反響と決めない(タカウルの見分け方と同じ)", () => {
    expect(pdfTarget("査定物件の所在地：東京都…")).toBe("document");
  });

  it("ほかの書類・文字の無い PDF は書類(受け取り箱)", () => {
    expect(pdfTarget("不動産売買契約書\n売主 …")).toBe("document");
    expect(pdfTarget("")).toBe("document");
    expect(pdfTarget(null)).toBe("document");
  });
});

describe("isHandoffTarget", () => {
  it("取り込みへ進む行き先だけ true", () => {
    expect(isHandoffTarget("reception")).toBe(true);
    expect(isHandoffTarget("registry_pdf")).toBe(true);
    expect(isHandoffTarget("document")).toBe(false);
    expect(isHandoffTarget("unknown")).toBe(false);
  });
});
