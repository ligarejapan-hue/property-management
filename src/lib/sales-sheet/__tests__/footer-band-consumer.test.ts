import { describe, it, expect } from "vitest";
import {
  buildConsumerFooterBand,
  buildConsumerFooterTransactionElements,
  readFooterData,
  CONSUMER_TEL_CTA,
  type FooterBandData,
} from "../footer-band";
import { CONSUMER_FOOTER, type Rect } from "../layout-engine";
import { COMPANY_INFO } from "../company-info";
import type { SalesSheetElement } from "../document-schema";

const FULL: FooterBandData = { transactionType: "専任", adType: "不可", compensation: "税込3%", staff: "山田", agent: "佐藤", specialNotes: "即入居可" };
const byId = (els: SalesSheetElement[], id: string) => els.find((e) => e.id === id);
const inside = (outer: Rect, r: Rect) => r.x >= outer.x - 1e-6 && r.y >= outer.y - 1e-6 && r.x + r.w <= outer.x + outer.w + 1e-6 && r.y + r.h <= outer.y + outer.h + 1e-6;

describe("buildConsumerFooterBand", () => {
  it("全要素が会社帯の中・正の寸法", () => {
    for (const el of buildConsumerFooterBand(CONSUMER_FOOTER, FULL)) {
      expect(el.w).toBeGreaterThan(0);
      expect(el.h).toBeGreaterThan(0);
      expect(inside(CONSUMER_FOOTER, el)).toBe(true);
    }
  });
  it("帯の外枠は白塗り・線なし、縦の区切り線は作らない", () => {
    const els = buildConsumerFooterBand(CONSUMER_FOOTER, FULL);
    expect(byId(els, "footer-band")).toMatchObject({ type: "shape", shape: "rect", fill: "#ffffff" });
    expect(byId(els, "footer-band")).not.toHaveProperty("stroke");
    expect(els.some((e) => e.id.startsWith("footer-divider"))).toBe(false);
  });
  it("会社情報と電話番号(19pt・右寄せ)を出す", () => {
    const els = buildConsumerFooterBand(CONSUMER_FOOTER, {});
    expect(byId(els, "footer-name-ja")).toMatchObject({ content: COMPANY_INFO.nameJa });
    expect(byId(els, "footer-tel-cta")).toMatchObject({ content: CONSUMER_TEL_CTA });
    expect(byId(els, "footer-tel-number")).toMatchObject({ content: COMPANY_INFO.tel, style: { fontSizePt: 19, bold: true, align: "right" } });
  });
  it("取引表は線なし・6値を読み戻せる", () => {
    const els = buildConsumerFooterBand(CONSUMER_FOOTER, FULL);
    expect(byId(els, "footer-terms-table")).toMatchObject({ type: "table", style: { borderless: true } });
    expect(byId(els, "footer-staff-table")).toMatchObject({ type: "table", style: { borderless: true } });
    expect(readFooterData(els)).toEqual(FULL);
  });
  it("担当の値が無ければ担当表を出さない", () => {
    const els = buildConsumerFooterTransactionElements(CONSUMER_FOOTER, { transactionType: "仲介" });
    expect(byId(els, "footer-terms-table")).toBeDefined();
    expect(byId(els, "footer-staff-table")).toBeUndefined();
  });
});
