import { describe, it, expect } from "vitest";
import {
  buildFooterTransactionElements,
  footerColumnGeometry,
  readFooterData,
  footerDataEqual,
  buildFooterBand,
  type FooterBandData,
} from "../footer-band";
import type { Rect } from "../layout-engine";
import type { TableElement } from "../document-schema";

const FOOTER: Rect = { x: 10, y: 180, w: 277, h: 24 };

const FULL: FooterBandData = {
  transactionType: "専任",
  adType: "不可",
  compensation: "税込3%",
  staff: "山田",
  agent: "佐藤",
  specialNotes: "即入居可",
};

function byId(els: { id: string }[], id: string) {
  return els.find((e) => e.id === id);
}

describe("footerColumnGeometry", () => {
  it("会社55% / 取引16% / 担当=残り で3分割する", () => {
    const g = footerColumnGeometry(FOOTER);
    expect(g.companyW).toBe(Math.round(277 * 0.55));
    expect(g.termsW).toBe(Math.round(277 * 0.16));
    expect(g.staffW).toBe(277 - g.companyW - g.termsW);
    expect(g.termsX0).toBe(10 + g.companyW);
    expect(g.staffX0).toBe(10 + g.companyW + g.termsW);
  });
});

describe("buildFooterTransactionElements", () => {
  it("全項目ありなら 取引条件表 + 担当区切り線 + 担当表 を出す", () => {
    const els = buildFooterTransactionElements(FOOTER, FULL);
    expect(byId(els, "footer-terms-table")).toBeDefined();
    expect(byId(els, "footer-divider-staff")).toBeDefined();
    expect(byId(els, "footer-staff-table")).toBeDefined();
    const terms = byId(els, "footer-terms-table") as TableElement;
    expect(terms.rows).toEqual([
      { label: "取引態様", value: "専任" },
      { label: "広告", value: "不可" },
      { label: "報酬", value: "税込3%" },
    ]);
  });

  it("担当系が全空なら担当表と担当区切り線を省く", () => {
    const els = buildFooterTransactionElements(FOOTER, {
      transactionType: "専任",
    });
    expect(byId(els, "footer-terms-table")).toBeDefined();
    expect(byId(els, "footer-staff-table")).toBeUndefined();
    expect(byId(els, "footer-divider-staff")).toBeUndefined();
  });

  it("幾何は帯内・w/h は正数", () => {
    const els = buildFooterTransactionElements(FOOTER, FULL);
    for (const e of els) {
      expect(e.w).toBeGreaterThan(0);
      expect(e.h).toBeGreaterThan(0);
      expect(e.x).toBeGreaterThanOrEqual(FOOTER.x);
      expect(e.y).toBeGreaterThanOrEqual(FOOTER.y);
    }
  });
});

describe("buildFooterBand parity", () => {
  it("buildFooterBand の取引系要素は buildFooterTransactionElements と一致する", () => {
    const band = buildFooterBand(FOOTER, FULL);
    const tx = buildFooterTransactionElements(FOOTER, FULL);
    const ids = ["footer-terms-table", "footer-divider-staff", "footer-staff-table"];
    for (const id of ids) {
      expect(byId(band, id)).toEqual(byId(tx, id));
    }
  });
});

describe("readFooterData", () => {
  it("帯テーブルから6値を復元する", () => {
    const band = buildFooterBand(FOOTER, FULL);
    expect(readFooterData(band)).toEqual(FULL);
  });

  it("担当表が無い帯では担当系は空文字で返す", () => {
    const band = buildFooterBand(FOOTER, { transactionType: "専任" });
    const d = readFooterData(band);
    expect(d.transactionType).toBe("専任");
    expect(d.staff).toBe("");
    expect(d.agent).toBe("");
    expect(d.specialNotes).toBe("");
  });
});

describe("footerDataEqual", () => {
  it("undefined と '' を同一視する", () => {
    expect(footerDataEqual({ transactionType: "専任" }, { transactionType: "専任", staff: "" })).toBe(true);
  });
  it("値が違えば false", () => {
    expect(footerDataEqual({ transactionType: "専任" }, { transactionType: "一般媒介" })).toBe(false);
  });
});
