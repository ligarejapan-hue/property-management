import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SalesSheetDocument } from "../document-schema";
import { A4_LANDSCAPE } from "../document-schema";

const read = vi.fn();
const keyFromUrl = vi.fn();
vi.mock("@/lib/storage", () => ({
  getStorage: () => ({ read, keyFromUrl }),
}));

import { inlineDocumentImages } from "../inline-images";

const baseDoc = (src: string): SalesSheetDocument => ({
  page: A4_LANDSCAPE,
  theme: { fontFamily: "sans-serif", accentColor: "#000" },
  elements: [
    { id: "p", type: "image", x: 0, y: 0, w: 10, h: 10, z: 1, src, fit: "cover" },
    { id: "t", type: "text", x: 0, y: 0, w: 10, h: 5, z: 2, content: "x", style: {} },
  ],
});

beforeEach(() => { read.mockReset(); keyFromUrl.mockReset(); });

describe("inlineDocumentImages", () => {
  it("/uploads/ 画像を data: に展開する", async () => {
    keyFromUrl.mockReturnValue("properties/a/1.jpg");
    read.mockResolvedValue({ body: Buffer.from([1, 2, 3]), contentType: "image/jpeg", size: 3 });
    const out = await inlineDocumentImages(baseDoc("/uploads/properties/a/1.jpg"));
    const img = out.elements.find((e) => e.type === "image");
    expect(img && img.type === "image" && img.src.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(out.elements).toHaveLength(2);
  });
  it("既に data: の画像は変更しない & storage を読まない", async () => {
    const out = await inlineDocumentImages(baseDoc("data:image/png;base64,AAAA"));
    const img = out.elements.find((e) => e.type === "image");
    expect(img && img.type === "image" && img.src).toBe("data:image/png;base64,AAAA");
    expect(read).not.toHaveBeenCalled();
  });
  it("読めない画像は要素を取り除く（壊れsrcを残さない）", async () => {
    keyFromUrl.mockReturnValue("k");
    read.mockResolvedValue(null);
    const out = await inlineDocumentImages(baseDoc("/uploads/x.jpg"));
    expect(out.elements.some((e) => e.type === "image")).toBe(false);
    expect(out.elements).toHaveLength(1);
  });
});
