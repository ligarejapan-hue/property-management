import { describe, it, expect } from "vitest";
import {
  parseSalesSheetDocument,
  salesSheetDocumentSchema,
  A4_LANDSCAPE,
  CONSUMER_TEMPLATE,
  isConsumerTemplate,
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

describe("色/フォント許可リスト (codex P2 SSRF根治)", () => {
  const base = { page: A4_LANDSCAPE, elements: [] };

  it("badgeのbgにimage-set()を含む値は拒否する (SSRF)", () => {
    const r = salesSheetDocumentSchema.safeParse({
      ...base,
      theme: { fontFamily: "sans-serif", accentColor: "#000" },
      elements: [
        { id: "b1", type: "badge", x: 0, y: 0, w: 20, h: 8, z: 1, label: "test", bg: 'image-set("http://169.254.169.254/" 1x)', fg: "#fff" },
      ],
    });
    expect(r.success).toBe(false);
  });

  it("badgeのbgに有効なhex色(#0e9f6e)は受理する", () => {
    const r = salesSheetDocumentSchema.safeParse({
      ...base,
      theme: { fontFamily: "sans-serif", accentColor: "#000" },
      elements: [
        { id: "b1", type: "badge", x: 0, y: 0, w: 20, h: 8, z: 1, label: "test", bg: "#0e9f6e", fg: "#fff" },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("themeのfontFamilyに</style>を含む値は拒否する", () => {
    const r = salesSheetDocumentSchema.safeParse({
      ...base,
      theme: { fontFamily: "a</style>b", accentColor: "#000" },
    });
    expect(r.success).toBe(false);
  });

  it("フィクスチャのフォント/色はそのまま受理される", () => {
    const r = salesSheetDocumentSchema.safeParse({
      ...base,
      theme: { fontFamily: '"Yu Gothic UI","Meiryo",sans-serif', accentColor: "#1f4e79" },
      elements: [
        { id: "b1", type: "badge", x: 0, y: 0, w: 20, h: 8, z: 1, label: "test", bg: "#0e9f6e", fg: "#ffffff" },
      ],
    });
    expect(r.success).toBe(true);
  });
});

describe("isSafeImageSrc (SSRF防止 ユニットテスト — Plan3: data:image/ と /uploads/ を許可)", () => {
  it("data:image/ URL を許可する", () => {
    expect(isSafeImageSrc("data:image/png;base64,AAAA")).toBe(true);
    expect(isSafeImageSrc("data:image/jpeg;base64,/9j/")).toBe(true);
  });

  it("/uploads/... ルート相対パスを許可する（Plan3: アプリ内蔵ストレージ）", () => {
    expect(isSafeImageSrc("/uploads/p/1.jpg")).toBe(true);
    expect(isSafeImageSrc("/uploads/sub/dir/photo.png")).toBe(true);
  });

  it("/uploads/ 以外の root-relative を拒否する", () => {
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

  it("/uploads/p/1.jpg を受理する（Plan3: アプリ内蔵ストレージ・エクスポート時に再認可）", () => {
    const r = salesSheetDocumentSchema.safeParse({
      page: A4_LANDSCAPE,
      theme: { fontFamily: "sans-serif", accentColor: "#000" },
      elements: [{ ...baseImg, src: "/uploads/p/1.jpg" }],
    });
    expect(r.success).toBe(true);
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

describe("表の任意指定とひな型の目印(消費者向けひな型)", () => {
  const base = { page: A4_LANDSCAPE, theme: { fontFamily: "sans-serif", accentColor: "#1f3a5f" } };
  const table = (style: Record<string, unknown>) => ({
    ...base,
    elements: [{ id: "t", type: "table", x: 0, y: 0, w: 50, h: 20, z: 1, rows: [], style }],
  });

  it("borderless / stripeColor / cellPaddingMm を受理する", () => {
    const doc = parseSalesSheetDocument(table({ borderless: true, stripeColor: "#eef2f7", cellPaddingMm: 1.2 }));
    const el = doc.elements[0];
    expect(el.type === "table" && el.style).toMatchObject({ borderless: true, stripeColor: "#eef2f7", cellPaddingMm: 1.2 });
  });
  it("危険な stripeColor を拒否する", () => {
    expect(() => parseSalesSheetDocument(table({ stripeColor: "url(http://x/)" }))).toThrow();
  });
  it("負の cellPaddingMm を拒否する", () => {
    expect(() => parseSalesSheetDocument(table({ cellPaddingMm: -1 }))).toThrow();
  });
  it("theme.template は consumer-2026-09 だけ受理し、無くても通る", () => {
    expect(parseSalesSheetDocument({ ...base, theme: { ...base.theme, template: CONSUMER_TEMPLATE }, elements: [] }).theme.template).toBe("consumer-2026-09");
    expect(() => parseSalesSheetDocument({ ...base, theme: { ...base.theme, template: "other" }, elements: [] })).toThrow();
    expect(parseSalesSheetDocument({ ...base, elements: [] }).theme.template).toBeUndefined();
  });
  it("isConsumerTemplate は目印の有無を返す", () => {
    expect(isConsumerTemplate({ theme: { template: CONSUMER_TEMPLATE } })).toBe(true);
    expect(isConsumerTemplate({ theme: {} })).toBe(false);
  });
});
