import { describe, it, expect } from "vitest";
import { buildSaleMansionDocument } from "../build-document";
import { salesSheetDocumentSchema } from "../document-schema";

const base = {
  property: {
    address: "東京都杉並区西荻北1-4-3",
    zoningDistrict: "第一種中高層住居専用地域",
    exclusiveArea: "67.21",
    layoutType: "3LDK",
    occupancyStatus: "vacant",
  },
  building: { name: "西荻リリエンハイム", totalFloors: 7, builtYear: 1972, structureType: "RC" },
  photos: [{ fileUrl: "/uploads/a.jpg" }],
};

// 既存 build-document-templates.test.ts の tableRow/texts/imageCount と同じ緩い型で
// element 配列を検査するローカルヘルパ（このファイル固有・他ビルダーには使わない）。
const tableRow = (doc: { elements: unknown[] }, label: string): string | undefined => {
  for (const el of doc.elements as { type: string; rows?: { label: string; value: string }[] }[]) {
    if (el.type === "table") {
      const r = el.rows?.find((row) => row.label === label);
      if (r) return r.value;
    }
  }
  return undefined;
};
const tableLabels = (doc: { elements: unknown[] }): string[] => {
  for (const el of doc.elements as { type: string; rows?: { label: string; value: string }[] }[]) {
    if (el.type === "table") return (el.rows ?? []).map((row) => row.label);
  }
  return [];
};
const imageCount = (doc: { elements: { type: string }[] }) =>
  doc.elements.filter((e) => e.type === "image").length;

describe("buildSaleMansionDocument（自社マイソク様式）", () => {
  it("スペック表に主要行が入り、キャッチ帯要素を含む", () => {
    const doc = buildSaleMansionDocument({
      ...base,
      overrides: { price: "6590", tax: "不課税", catchCopy: "北東角部屋" },
    });
    const labels = tableLabels(doc);
    expect(labels).toContain("用途地域");
    expect(labels).toContain("専有面積");
    expect(labels).not.toContain("うち消費税"); // 不課税
    // キャッチ帯(shape or text)が存在
    expect(doc.elements.some((e) => e.type === "shape")).toBe(true);
    expect(doc.elements.some((e) => e.type === "text" && e.content.includes("北東角部屋"))).toBe(true);
  });

  it("課税ならうち消費税行が出る", () => {
    const doc = buildSaleMansionDocument({
      ...base,
      overrides: { price: "6590", tax: "課税", taxAmount: "300" },
    });
    const labels = tableLabels(doc);
    expect(labels).toContain("うち消費税");
    expect(tableRow(doc, "うち消費税")).toBe("300万円");
  });

  it("会社セクション(取引態様/報酬/広告/担当/取引士/特記)はスペック表の行にならず、フッターに出す", () => {
    const doc = buildSaleMansionDocument({
      ...base,
      overrides: {
        transactionType: "専任媒介",
        compensation: "分かれ",
        adType: "広告可",
        staff: "山田",
        agent: "佐藤",
        specialNotes: "ペット相談可",
      },
    });
    const labels = tableLabels(doc);
    expect(labels).not.toContain("取引態様");
    expect(labels).not.toContain("報酬");
    expect(labels).not.toContain("広告");
    expect(labels).not.toContain("担当者");
    expect(labels).not.toContain("取引士");
    expect(labels).not.toContain("特記事項");
    const json = JSON.stringify(doc.elements);
    expect(json).toContain("専任媒介");
    expect(json).toContain("山田");
    expect(json).toContain("ペット相談可");
  });

  it("用途地域は自動反映(zoningDistrict)+overridesの追加選択を併記する", () => {
    const doc = buildSaleMansionDocument({
      ...base,
      overrides: { useDistrict: ["近隣商業地域"] },
    });
    expect(tableRow(doc, "用途地域")).toBe("第一種中高層住居専用地域 / 近隣商業地域");
  });

  it("築年月はoverride優先、無ければbuilding.builtYearから自動反映", () => {
    const auto = buildSaleMansionDocument({ ...base, overrides: {} });
    expect(tableRow(auto, "築年月")).toBe("1972年");
    const overridden = buildSaleMansionDocument({
      ...base,
      overrides: { builtYearMonth: "1972年5月" },
    });
    expect(tableRow(overridden, "築年月")).toBe("1972年5月");
  });

  it("管理費/修繕積立金/所在階/地上階/現況を自動反映して整形する", () => {
    const doc = buildSaleMansionDocument({
      property: {
        ...base.property,
        floorNo: 4,
        managementFee: 12000,
        repairReserveFee: 8500,
        occupancyStatus: "occupied",
      },
      building: { ...base.building, managementCompany: "リガーレ管理", totalUnits: 24 },
      photos: base.photos,
    });
    expect(tableRow(doc, "管理費")).toBe("12,000円/月");
    expect(tableRow(doc, "修繕積立金")).toBe("8,500円/月");
    expect(tableRow(doc, "所在階")).toBe("4階");
    expect(tableRow(doc, "地上階")).toBe("7階");
    expect(tableRow(doc, "総戸数")).toBe("24戸");
    expect(tableRow(doc, "管理会社")).toBe("リガーレ管理");
    expect(tableRow(doc, "現況")).toBe("入居中");
  });

  it("写真3枚→image要素3、0枚→0", () => {
    const photos3 = [
      { fileUrl: "/uploads/1.jpg" },
      { fileUrl: "/uploads/2.jpg" },
      { fileUrl: "/uploads/3.jpg" },
    ];
    expect(imageCount(buildSaleMansionDocument({ ...base, photos: photos3 }))).toBe(3);
    expect(imageCount(buildSaleMansionDocument({ ...base, photos: [] }))).toBe(0);
  });

  it("間取り画像を渡すと image 要素が追加される(任意・未指定なら追加されない)", () => {
    const withPlan = buildSaleMansionDocument({
      ...base,
      floorPlanImage: { fileUrl: "/uploads/plan.jpg" },
    });
    const withoutPlan = buildSaleMansionDocument({ ...base });
    expect(withPlan.elements.some((e) => e.type === "image" && e.src === "/uploads/plan.jpg")).toBe(true);
    expect(withoutPlan.elements.some((e) => e.type === "image" && e.src === "/uploads/plan.jpg")).toBe(
      false,
    );
    expect(salesSheetDocumentSchema.safeParse(withPlan).success).toBe(true);
  });

  it("会社定数(COMPANY)がフッターに含まれる", () => {
    const doc = buildSaleMansionDocument({ ...base });
    expect(JSON.stringify(doc.elements)).toContain("株式会社リガーレジャパン");
  });

  it("A4横で schema 検証を通る（保存可能な document）", () => {
    const doc = buildSaleMansionDocument({
      ...base,
      overrides: {
        price: "6590",
        tax: "課税",
        taxAmount: "300",
        catchCopy: "駅近角部屋",
        salesPoints: ["リノベ済", "南向き", "即入居可"],
      },
    });
    expect(doc.page.orientation).toBe("landscape");
    expect(salesSheetDocumentSchema.safeParse(doc).success).toBe(true);
  });
});
