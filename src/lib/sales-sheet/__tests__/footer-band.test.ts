import { describe, it, expect } from "vitest";
import { buildFooterBand } from "../footer-band";
import { COMPANY_INFO } from "../company-info";

const FOOTER = { x: 10, y: 184, w: 277, h: 24 };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const byId = (els: any[], id: string) => els.find((e) => e.id === id);

describe("buildFooterBand", () => {
  it("会社ブロックの各文言を出す", () => {
    const els = buildFooterBand(FOOTER, { transactionType: "仲介" });
    expect(byId(els, "footer-name-ja").content).toBe(COMPANY_INFO.nameJa);
    expect(byId(els, "footer-name-en").content).toBe(COMPANY_INFO.nameEn);
    expect(byId(els, "footer-license").content).toContain("東京都知事免許(1)第108344号");
    expect(byId(els, "footer-email").content).toContain(COMPANY_INFO.email);
    expect(byId(els, "footer-hp").content).toContain(COMPANY_INFO.hp);
    expect(byId(els, "footer-address").content).toContain(COMPANY_INFO.address);
  });
  it("取引条件テーブルに取引態様/広告/報酬を流し込む", () => {
    const els = buildFooterBand(FOOTER, { transactionType: "仲介", adType: "不可", compensation: "相談" });
    const t = byId(els, "footer-terms-table");
    expect(t.type).toBe("table");
    expect(JSON.stringify(t.rows)).toContain("仲介");
    expect(JSON.stringify(t.rows)).toContain("相談");
  });
  it("担当情報があれば担当テーブルを出す", () => {
    const els = buildFooterBand(FOOTER, { staff: "村山廉太郎", agent: "村山廉太郎" });
    expect(byId(els, "footer-staff-table")).toBeTruthy();
    expect(JSON.stringify(byId(els, "footer-staff-table").rows)).toContain("村山廉太郎");
  });
  it("担当情報が全空なら担当テーブルを省略（コンパクト版）", () => {
    const els = buildFooterBand(FOOTER, { transactionType: "仲介" });
    expect(byId(els, "footer-staff-table")).toBeUndefined();
  });
  it("全要素が帯矩形の内側に収まる（A4/幾何不変条件）", () => {
    const els = buildFooterBand(FOOTER, { transactionType: "仲介", staff: "村山廉太郎" });
    for (const e of els) {
      expect(e.x).toBeGreaterThanOrEqual(FOOTER.x - 0.01);
      expect(e.y).toBeGreaterThanOrEqual(FOOTER.y - 0.01);
      expect(e.x + e.w).toBeLessThanOrEqual(FOOTER.x + FOOTER.w + 0.01);
      expect(e.y + e.h).toBeLessThanOrEqual(FOOTER.y + FOOTER.h + 0.01);
    }
  });
});
