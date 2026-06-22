import { describe, it, expect } from "vitest";
import {
  parseSalesSheetDocument,
  salesSheetDocumentSchema,
  A4_LANDSCAPE,
} from "../document-schema";
import { isSafeImageSrc } from "../css-safety";

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

describe("isSafeImageSrc (SSRF防止 ユニットテスト — Plan1: data:image/ のみ)", () => {
  it("data:image/ URL を許可する", () => {
    expect(isSafeImageSrc("data:image/png;base64,AAAA")).toBe(true);
    expect(isSafeImageSrc("data:image/jpeg;base64,/9j/")).toBe(true);
  });

  it("ルート相対パス(/uploads/...)は Plan2 で対応するため Plan1 では拒否する", () => {
    expect(isSafeImageSrc("/uploads/p/1.jpg")).toBe(false);
    expect(isSafeImageSrc("/images/photo.png")).toBe(false);
  });

  it("http:// 絶対URLを拒否する（SSRF）", () => {
    expect(isSafeImageSrc("http://internal/x")).toBe(false);
    expect(isSafeImageSrc("http://169.254.169.254/metadata")).toBe(false);
  });

  it("https:// 絶対URLを拒否する（SSRF）", () => {
    expect(isSafeImageSrc("https://evil.example.com/x")).toBe(false);
  });

  it("javascript: URLを拒否する（XSS）", () => {
    expect(isSafeImageSrc("javascript:alert(1)")).toBe(false);
  });

  it("プロトコル相対URL(//)を拒否する", () => {
    expect(isSafeImageSrc("//evil.com/x")).toBe(false);
  });
});

describe("imageElementSchema — srcバリデーション (SSRF防止)", () => {
  const baseImg = { id: "i1", type: "image", x: 0, y: 0, w: 10, h: 10, z: 0, fit: "cover" };

  it("http://internal/x を拒否する", () => {
    const r = salesSheetDocumentSchema.safeParse({
      page: A4_LANDSCAPE,
      theme: { fontFamily: "sans-serif", accentColor: "#000" },
      elements: [{ ...baseImg, src: "http://internal/x" }],
    });
    expect(r.success).toBe(false);
  });

  it("javascript:alert(1) を拒否する", () => {
    const r = salesSheetDocumentSchema.safeParse({
      page: A4_LANDSCAPE,
      theme: { fontFamily: "sans-serif", accentColor: "#000" },
      elements: [{ ...baseImg, src: "javascript:alert(1)" }],
    });
    expect(r.success).toBe(false);
  });

  it("data:image/png;base64,AAAA を受理する", () => {
    const r = salesSheetDocumentSchema.safeParse({
      page: A4_LANDSCAPE,
      theme: { fontFamily: "sans-serif", accentColor: "#000" },
      elements: [{ ...baseImg, src: "data:image/png;base64,AAAA" }],
    });
    expect(r.success).toBe(true);
  });

  it("/uploads/p/1.jpg を拒否する（Plan1: root-relative は Plan2 で対応）", () => {
    const r = salesSheetDocumentSchema.safeParse({
      page: A4_LANDSCAPE,
      theme: { fontFamily: "sans-serif", accentColor: "#000" },
      elements: [{ ...baseImg, src: "/uploads/p/1.jpg" }],
    });
    expect(r.success).toBe(false);
  });
});

describe("qrElementSchema — dataUrlバリデーション (SSRF防止)", () => {
  const baseQr = { id: "q1", type: "qr", x: 0, y: 0, w: 20, h: 20, z: 0 };

  it("data:image/png;... を受理する", () => {
    const r = salesSheetDocumentSchema.safeParse({
      page: A4_LANDSCAPE,
      theme: { fontFamily: "sans-serif", accentColor: "#000" },
      elements: [{ ...baseQr, dataUrl: "data:image/png;base64,AAAA" }],
    });
    expect(r.success).toBe(true);
  });

  it("http://... を拒否する", () => {
    const r = salesSheetDocumentSchema.safeParse({
      page: A4_LANDSCAPE,
      theme: { fontFamily: "sans-serif", accentColor: "#000" },
      elements: [{ ...baseQr, dataUrl: "http://evil.example.com/qr.png" }],
    });
    expect(r.success).toBe(false);
  });

  it("/uploads/qr.png を拒否する（qrはdata:imageのみ）", () => {
    const r = salesSheetDocumentSchema.safeParse({
      page: A4_LANDSCAPE,
      theme: { fontFamily: "sans-serif", accentColor: "#000" },
      elements: [{ ...baseQr, dataUrl: "/uploads/qr.png" }],
    });
    expect(r.success).toBe(false);
  });
});
