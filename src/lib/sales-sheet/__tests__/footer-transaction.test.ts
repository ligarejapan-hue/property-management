import { describe, it, expect } from "vitest";
import {
  buildConsumerFooterTransactionElements,
  readFooterData,
  footerDataEqual,
  buildConsumerFooterBand,
  type FooterBandData,
} from "../footer-band";
import { CONSUMER_FOOTER } from "../layout-engine";
import type { TableElement } from "../document-schema";

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

describe("buildConsumerFooterTransactionElements", () => {
  it("全項目ありなら 取引条件表 + 担当表 を出す", () => {
    const els = buildConsumerFooterTransactionElements(CONSUMER_FOOTER, FULL);
    expect(byId(els, "footer-terms-table")).toBeDefined();
    expect(byId(els, "footer-staff-table")).toBeDefined();
    const terms = byId(els, "footer-terms-table") as TableElement;
    expect(terms.rows).toEqual([
      { label: "取引態様", value: "専任" },
      { label: "広告", value: "不可" },
      { label: "報酬", value: "税込3%" },
    ]);
  });

  it("担当系が全空なら担当表を省く", () => {
    const els = buildConsumerFooterTransactionElements(CONSUMER_FOOTER, {
      transactionType: "専任",
    });
    expect(byId(els, "footer-terms-table")).toBeDefined();
    expect(byId(els, "footer-staff-table")).toBeUndefined();
  });

  it("幾何は帯内・w/h は正数", () => {
    const els = buildConsumerFooterTransactionElements(CONSUMER_FOOTER, FULL);
    for (const e of els) {
      expect(e.w).toBeGreaterThan(0);
      expect(e.h).toBeGreaterThan(0);
      expect(e.x).toBeGreaterThanOrEqual(CONSUMER_FOOTER.x);
      expect(e.y).toBeGreaterThanOrEqual(CONSUMER_FOOTER.y);
    }
  });
});

describe("buildConsumerFooterBand parity", () => {
  it("buildConsumerFooterBand の取引系要素は buildConsumerFooterTransactionElements と一致する", () => {
    const band = buildConsumerFooterBand(CONSUMER_FOOTER, FULL);
    const tx = buildConsumerFooterTransactionElements(CONSUMER_FOOTER, FULL);
    const ids = ["footer-terms-table", "footer-staff-table"];
    for (const id of ids) {
      expect(byId(band, id)).toEqual(byId(tx, id));
    }
  });
});

describe("readFooterData", () => {
  it("帯テーブルから6値を復元する", () => {
    const band = buildConsumerFooterBand(CONSUMER_FOOTER, FULL);
    expect(readFooterData(band)).toEqual(FULL);
  });

  it("担当表が無い帯では担当系は空文字で返す", () => {
    const band = buildConsumerFooterBand(CONSUMER_FOOTER, { transactionType: "専任" });
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
