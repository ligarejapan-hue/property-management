import { describe, it, expect, vi } from "vitest";
import { salesSheetDocumentSchema } from "../document-schema";

vi.mock("@/lib/storage", () => ({
  getStorage: () => ({
    keyFromUrl: () => "k",
    read: async () => ({ body: Buffer.from([1]), contentType: "image/jpeg", size: 1 }),
  }),
}));

import { buildInitialSalesSheetDocument, toCanonicalUploadsSrc } from "../build-document";
import { isSafeImageSrc } from "../css-safety";

// 売土地は自社マイソク様式に作り直し、専用テスト build-land.test.ts に移設した
// （[F2-A Task3]・build-mansion.test.ts への移設と同じ経緯）。ここでは
// buildInitialSalesSheetDocument（写真の data: 展開）と toCanonicalUploadsSrc のみを扱う。
const input = {
  property: {
    address: "東京都世田谷区上馬４丁目",
    zoningDistrict: "第一種低層住居専用地域",
    buildingCoverageRatio: "50",
    floorAreaRatio: "100",
    roadType: "公道",
    roadWidth: "4.0",
    occupancyStatus: "更地",
  },
  photo: { fileUrl: "/uploads/properties/a/1.jpg" },
  overrides: {
    price: "3,480万円",
    access: "東急田園都市線「駒沢大学」駅 徒歩8分",
    landArea: "120.50㎡",
    landCategory: "宅地",
    transactionType: "仲介",
    deliveryTiming: "相談",
    remarks: "南西角地・整形地",
  },
};

describe("buildInitialSalesSheetDocument", () => {
  it("写真を data: 化し、schema 検証を通る doc を返す", async () => {
    const doc = await buildInitialSalesSheetDocument(input);
    expect(salesSheetDocumentSchema.safeParse(doc).success).toBe(true);
    const img = doc.elements.find((e) => e.type === "image");
    expect(img && img.type === "image" && img.src.startsWith("data:image/")).toBe(true);
  });
});

describe("toCanonicalUploadsSrc", () => {
  it("normalizes a resolvable storage URL to a /uploads/{key} src that passes isSafeImageSrc", () => {
    // server backend may persist /{bucket}/{key} or absolute URLs; keyFromUrl resolves the key.
    const storage = { keyFromUrl: () => "properties/abc/1.jpg" };
    const src = toCanonicalUploadsSrc("/property-management/properties/abc/1.jpg", storage);
    expect(src).toBe("/uploads/properties/abc/1.jpg");
    expect(isSafeImageSrc(src!)).toBe(true);
  });

  it("returns null when the key cannot be resolved (photo is dropped)", () => {
    const storage = { keyFromUrl: () => null };
    expect(toCanonicalUploadsSrc("https://evil.example/x.jpg", storage)).toBeNull();
  });

  it("returns null when the resolved key yields a src that fails isSafeImageSrc (drop, not 422)", () => {
    // key valid for storage but unsafe as an image src (space → rejected by isSafeImageSrc)
    const storage = { keyFromUrl: () => "a b.jpg" };
    const src = toCanonicalUploadsSrc("/property-management/a b.jpg", storage);
    expect(src).toBeNull();
  });
});
