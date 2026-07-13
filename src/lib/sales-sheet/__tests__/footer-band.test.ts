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
    expect(byId(els, "footer-license").content).toContain("東京都知事免許(1)第108344号");
    expect(byId(els, "footer-email").content).toContain(COMPANY_INFO.email);
    expect(byId(els, "footer-hp").content).toContain(COMPANY_INFO.hp);
    expect(byId(els, "footer-address").content).toContain(COMPANY_INFO.address);
  });
  it("company を渡すとその会社名/連絡先が入る", () => {
    const els = buildFooterBand(FOOTER, { transactionType: "仲介" }, {
      nameJa: "株式会社テスト", license: "免許X", tel: "01-1", fax: "02-2",
      email: "a@b.jp", hp: "https://x.jp/", address: "000-0000 テスト町1",
    });
    const nameJa = els.find((e) => e.id === "footer-name-ja");
    expect(nameJa && "content" in nameJa && nameJa.content).toBe("株式会社テスト");
  });
  it("英字社名・保証協会・所属協会の要素は出力されない", () => {
    const els = buildFooterBand(FOOTER, {});
    expect(els.find((e) => e.id === "footer-name-en")).toBeUndefined();
    expect(els.find((e) => e.id === "footer-guarantee")).toBeUndefined();
    expect(els.find((e) => e.id === "footer-member")).toBeUndefined();
  });
  it("company 未指定でも既定(COMPANY_INFO)で会社名が入る（後方互換）", () => {
    const els = buildFooterBand(FOOTER, {});
    const nameJa = els.find((e) => e.id === "footer-name-ja");
    expect(nameJa && "content" in nameJa && nameJa.content).toBeTruthy();
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
  it("極端に小さい footer でも全要素の w/h は正（document-schema 準拠）かつ内側に収まる", () => {
    // 実運用の footer は 277×24。ここでは想定外に小さい矩形でも w:0/h:0 を出さない
    // （schema は w/h を正数必須＝保存時 422 回避）ことを固定する。
    const tiny = { x: 10, y: 200, w: 60, h: 8 };
    const els = buildFooterBand(tiny, { transactionType: "仲介", staff: "村山廉太郎", specialNotes: "注意" });
    for (const e of els) {
      expect(e.w).toBeGreaterThan(0);
      expect(e.h).toBeGreaterThan(0);
      expect(e.x + e.w).toBeLessThanOrEqual(tiny.x + tiny.w + 0.01);
      expect(e.y + e.h).toBeLessThanOrEqual(tiny.y + tiny.h + 0.01);
    }
  });
});
