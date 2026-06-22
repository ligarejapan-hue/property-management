import { describe, it, expect } from "vitest";
import {
  parseSalesSheetDocument,
  salesSheetDocumentSchema,
  A4_LANDSCAPE,
} from "../document-schema";

describe("salesSheetDocumentSchema", () => {
  it("最小の有効documentを受理し、styleの既定({})を補完する", () => {
    const doc = parseSalesSheetDocument({
      page: A4_LANDSCAPE,
      theme: { fontFamily: "sans-serif", accentColor: "#1f4e79" },
      elements: [
        { id: "t1", type: "text", x: 10, y: 10, w: 50, h: 8, z: 1, content: "価格" },
      ],
    });
    expect(doc.page.width).toBe(297);
    expect(doc.elements).toHaveLength(1);
    const el = doc.elements[0];
    expect(el.type).toBe("text");
    if (el.type === "text") expect(el.style).toEqual({});
  });

  it("未知の type を拒否する", () => {
    const r = salesSheetDocumentSchema.safeParse({
      page: A4_LANDSCAPE,
      theme: { fontFamily: "sans-serif", accentColor: "#000" },
      elements: [{ id: "x", type: "bogus", x: 0, y: 0, w: 1, h: 1, z: 0 }],
    });
    expect(r.success).toBe(false);
  });

  it("w/h が 0 以下なら拒否する", () => {
    const r = salesSheetDocumentSchema.safeParse({
      page: A4_LANDSCAPE,
      theme: { fontFamily: "sans-serif", accentColor: "#000" },
      elements: [{ id: "t", type: "text", x: 0, y: 0, w: 0, h: 5, z: 0, content: "x" }],
    });
    expect(r.success).toBe(false);
  });
});
