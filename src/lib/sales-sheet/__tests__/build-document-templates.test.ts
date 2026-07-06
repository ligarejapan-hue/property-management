import { describe, it, expect } from "vitest";
import { salesSheetDocumentSchema } from "../document-schema";
import {
  buildSaleHouseDocument,
  buildSaleBuildingDocument,
  type SaleHouseInput,
  type SaleBuildingInput,
} from "../build-document";

const photos3 = [
  { fileUrl: "/uploads/properties/a/1.jpg" },
  { fileUrl: "/uploads/properties/a/2.jpg" },
  { fileUrl: "/uploads/properties/a/3.jpg" },
];

const texts = (doc: { elements: { type: string }[] }) =>
  JSON.stringify(doc.elements);

const tableRow = (doc: { elements: unknown[] }, label: string): string | undefined => {
  for (const el of doc.elements as { type: string; rows?: { label: string; value: string }[] }[]) {
    if (el.type === "table") {
      const r = el.rows?.find((row) => row.label === label);
      if (r) return r.value;
    }
  }
  return undefined;
};

const imageCount = (doc: { elements: { type: string }[] }) =>
  doc.elements.filter((e) => e.type === "image").length;

// 売マンション（区分）は自社マイソク様式に作り直し、専用テスト
// build-mansion.test.ts に移設（field-model/sheet-rows 駆動のスペック表・
// キャッチ帯・会社フッターを検証）。ここでは他種別のみを扱う。

// ---------------- 売戸建 ----------------
describe("buildSaleHouseDocument", () => {
  const input: SaleHouseInput = {
    property: {
      address: "神奈川県横浜市港北区日吉4-5-6",
      layoutType: "4LDK",
      zoningDistrict: "第一種低層住居専用地域",
      buildingCoverageRatio: "50",
      floorAreaRatio: "100",
      roadType: "公道",
      roadWidth: "4.0",
      occupancyStatus: "vacant",
    },
    photos: [photos3[0]],
    overrides: {
      price: "5,280万円",
      access: "東急東横線「日吉」駅 徒歩10分",
      landArea: "110.25㎡",
      buildingArea: "95.60㎡",
      builtYearMonth: "2018年6月",
      structure: "木造2階建",
      transactionType: "専任媒介",
      deliveryTiming: "相談",
      remarks: "南向き・車庫2台",
    },
  };

  it("A4横で schema 検証を通る", () => {
    const doc = buildSaleHouseDocument(input);
    expect(doc.page.orientation).toBe("landscape");
    expect(salesSheetDocumentSchema.safeParse(doc).success).toBe(true);
  });

  it("表題売戸建、土地/建物面積・構造・建蔽率容積率・接道を含む", () => {
    const doc = buildSaleHouseDocument(input);
    expect(texts(doc)).toContain("売戸建");
    expect(tableRow(doc, "土地面積")).toBe("110.25㎡");
    expect(tableRow(doc, "建物面積")).toBe("95.60㎡");
    expect(tableRow(doc, "構造")).toBe("木造2階建");
    expect(tableRow(doc, "建蔽率・容積率")).toContain("50");
    expect(tableRow(doc, "接道")).toContain("公道");
    expect(tableRow(doc, "現況")).toBe("空室"); // localizeOccupancy("vacant")
  });

  it("写真1枚 → image 要素1つ", () => {
    expect(imageCount(buildSaleHouseDocument(input))).toBe(1);
  });
});

// ---------------- 一棟 ----------------
describe("buildSaleBuildingDocument", () => {
  const base: SaleBuildingInput = {
    property: {
      address: "千葉県船橋市本町7-8-9",
      zoningDistrict: "近隣商業地域",
      buildingCoverageRatio: "80",
      floorAreaRatio: "300",
      roadType: "公道",
      roadWidth: "6.0",
      occupancyStatus: "occupied",
    },
    kind: "mansion",
    photos: photos3,
    overrides: {
      price: "1億2,800万円",
      access: "JR総武線「船橋」駅 徒歩7分",
      landArea: "250.00㎡",
      totalFloorArea: "620.50㎡",
      totalUnits: "12",
      builtYearMonth: "2010年3月",
      structure: "RC造5階建",
      grossYield: "7.8%",
      expectedIncome: "980万円/年",
      transactionType: "仲介",
      deliveryTiming: "相談",
      remarks: "満室稼働中",
    },
  };

  it("A4横で schema 検証を通る", () => {
    const doc = buildSaleBuildingDocument(base);
    expect(doc.page.orientation).toBe("landscape");
    expect(salesSheetDocumentSchema.safeParse(doc).success).toBe(true);
  });

  it("延床/総戸数/想定利回り/満室想定収入を含み、kind で表題を出し分ける", () => {
    const m = buildSaleBuildingDocument(base);
    expect(texts(m)).toContain("一棟マンション");
    expect(tableRow(m, "延床面積")).toBe("620.50㎡");
    expect(tableRow(m, "総戸数")).toBe("12戸");
    expect(tableRow(m, "想定利回り")).toBe("7.8%");
    expect(tableRow(m, "満室想定収入")).toBe("980万円/年");

    const a = buildSaleBuildingDocument({ ...base, kind: "apartment" });
    expect(texts(a)).toContain("一棟アパート");
  });
});
