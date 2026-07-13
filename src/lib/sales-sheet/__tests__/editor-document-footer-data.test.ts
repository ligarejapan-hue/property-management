import { describe, it, expect } from "vitest";
import { editFooterData } from "../editor-document";
import type { EditorState } from "../editor-document";
import { buildFooterBand, readFooterData, type FooterBandData } from "../footer-band";
import { A4_LANDSCAPE, parseSalesSheetDocument } from "../document-schema";
import type { Rect } from "../layout-engine";

const FOOTER: Rect = { x: 10, y: 180, w: 277, h: 24 };

function stateWith(data: FooterBandData): EditorState {
  const elements = buildFooterBand(FOOTER, data);
  return {
    document: { page: A4_LANDSCAPE, theme: { fontFamily: "sans-serif", accentColor: "#15324f" }, elements },
    selectedId: null,
    dirty: false,
  };
}

describe("editFooterData", () => {
  it("値を変えると取引表に反映され dirty=true・document は parse 可能", () => {
    const s0 = stateWith({ transactionType: "専任" });
    const s1 = editFooterData(s0, { transactionType: "一般媒介", compensation: "税込3%" });
    expect(s1).not.toBe(s0);
    expect(s1.dirty).toBe(true);
    expect(() => parseSalesSheetDocument(s1.document)).not.toThrow();
    expect(readFooterData(s1.document.elements)).toMatchObject({
      transactionType: "一般媒介",
      compensation: "税込3%",
    });
  });

  it("作成時に空だった担当を後から入れると担当表が復活する", () => {
    const s0 = stateWith({ transactionType: "専任" });
    expect(s0.document.elements.find((e) => e.id === "footer-staff-table")).toBeUndefined();
    const s1 = editFooterData(s0, { transactionType: "専任", staff: "山田" });
    expect(s1.document.elements.find((e) => e.id === "footer-staff-table")).toBeDefined();
    expect(readFooterData(s1.document.elements).staff).toBe("山田");
  });

  it("担当を全て消すと担当表が消える", () => {
    const s0 = stateWith({ transactionType: "専任", staff: "山田" });
    const s1 = editFooterData(s0, { transactionType: "専任", staff: "" });
    expect(s1.document.elements.find((e) => e.id === "footer-staff-table")).toBeUndefined();
  });

  it("現状と等価な値なら no-op(同一参照)", () => {
    const s0 = stateWith({ transactionType: "専任", staff: "山田" });
    const s1 = editFooterData(s0, { transactionType: "専任", staff: "山田", adType: "" });
    expect(s1).toBe(s0);
  });

  it("footer-band 外枠が無い document では no-op(同一参照)", () => {
    const s0 = stateWith({ transactionType: "専任" });
    const stripped: EditorState = {
      ...s0,
      document: {
        ...s0.document,
        elements: s0.document.elements.filter((e) => e.id !== "footer-band"),
      },
    };
    const s1 = editFooterData(stripped, { transactionType: "一般媒介" });
    expect(s1).toBe(stripped);
  });

  it("要素順: 取引表は footer-divider-terms の直後に来る", () => {
    const s0 = stateWith({ transactionType: "専任" });
    const s1 = editFooterData(s0, { transactionType: "一般媒介" });
    const ids = s1.document.elements.map((e) => e.id);
    expect(ids.indexOf("footer-terms-table")).toBe(ids.indexOf("footer-divider-terms") + 1);
  });
});
