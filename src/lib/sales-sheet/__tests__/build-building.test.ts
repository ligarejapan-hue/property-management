import { describe, it, expect } from "vitest";
import { buildSaleBuildingDocument } from "../build-document";
import { salesSheetDocumentSchema } from "../document-schema";
import { mapOccupancyStatusToMansionOccupancy } from "../occupancy";

// [F2-C Task2] 一棟(building)を自社マイソク様式(buildSpecSheetDocument + BUILDING_FIELDS駆動)
// に作り直したビルダーのテスト。build-house.test.ts と同じ緩い型のローカルヘルパーを使う。
// house との差分: 見出しが kind で二分岐(一棟マンション/一棟アパート)・収益系項目
// (総戸数/想定利回り/満室想定収入)・付帯権利。現況語彙は house/mansion と同一。

const base = {
  property: {
    address: "東京都豊島区南池袋1-2-3",
    zoningDistrict: "商業地域",
    buildingCoverageRatio: "80",
    floorAreaRatio: "400",
    roadType: "公道",
    roadWidth: "6.0",
    occupancyStatus: "occupied",
  },
  photos: [{ fileUrl: "/uploads/b.jpg" }],
};

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

const findEl = (doc: { elements: unknown[] }, id: string) =>
  (doc.elements as { id: string }[]).find((e) => e.id === id);

describe("buildSaleBuildingDocument（自社マイソク様式・[F2-C Task2]）", () => {
  it("スペック表に主要行(用途地域/付帯権利/延床面積/収益系)が入り、catch-band要素を含む", () => {
    const doc = buildSaleBuildingDocument({
      ...base,
      overrides: {
        price: "39800",
        landRight: "所有権",
        totalFloorArea: "560.50",
        catchCopy: "駅徒歩3分・満室稼働中",
      },
    });
    const labels = tableLabels(doc);
    expect(labels).toContain("用途地域");
    expect(labels).toContain("付帯権利");
    expect(labels).toContain("延床面積");
    expect(labels).toContain("総戸数");
    expect(labels).toContain("想定利回り");
    expect(findEl(doc, "catch-band")).toMatchObject({ type: "shape", shape: "rect", fill: "#15324f" });
    expect(doc.elements.some((e) => e.type === "text" && e.content.includes("満室稼働中"))).toBe(true);
  });

  it("表題はkindで二分岐(一棟マンション/一棟アパート)、kind未指定は一棟マンション", () => {
    const mansion = buildSaleBuildingDocument({ ...base, kind: "mansion", overrides: { price: "39800" } });
    expect(findEl(mansion, "heading")).toMatchObject({ content: "一棟マンション" });
    expect(findEl(mansion, "price")).toMatchObject({ content: "39800万円" });

    const apartment = buildSaleBuildingDocument({ ...base, kind: "apartment", overrides: { price: "18000" } });
    expect(findEl(apartment, "heading")).toMatchObject({ content: "一棟アパート" });

    const defaultKind = buildSaleBuildingDocument({ ...base, overrides: {} });
    expect(findEl(defaultKind, "heading")).toMatchObject({ content: "一棟マンション" });
  });

  it("収益系(総戸数/想定利回り/満室想定収入/延床面積)が単位付きで表に入る", () => {
    const doc = buildSaleBuildingDocument({
      ...base,
      overrides: { totalUnits: "12", grossYield: "7.8", expectedIncome: "980", totalFloorArea: "560.50" },
    });
    expect(tableRow(doc, "総戸数")).toBe("12戸");
    expect(tableRow(doc, "想定利回り")).toBe("7.8％");
    expect(tableRow(doc, "満室想定収入(年額)")).toBe("980万円");
    expect(tableRow(doc, "延床面積")).toBe("560.50㎡");
  });

  it("想定利回りは半角/全角%を二重付与しない", () => {
    expect(
      tableRow(buildSaleBuildingDocument({ ...base, overrides: { grossYield: "7.8%" } }), "想定利回り"),
    ).toBe("7.8％");
    expect(
      tableRow(buildSaleBuildingDocument({ ...base, overrides: { grossYield: "7.8％" } }), "想定利回り"),
    ).toBe("7.8％");
  });

  it("満室想定収入はすでに万円が付いていても二重化しない", () => {
    expect(
      tableRow(buildSaleBuildingDocument({ ...base, overrides: { expectedIncome: "980万円" } }), "満室想定収入(年額)"),
    ).toBe("980万円");
  });

  it("地目/接道方向の複数選択は「 / 」で併記される", () => {
    const doc = buildSaleBuildingDocument({
      ...base,
      overrides: { landCategory: ["宅地", "雑種地"], roadDirections: ["南", "東"] },
    });
    expect(tableRow(doc, "地目")).toBe("宅地 / 雑種地");
    expect(tableRow(doc, "接道方向")).toBe("南 / 東");
  });

  it("課税ならうち消費税行が出て、不課税なら出ない", () => {
    const taxed = buildSaleBuildingDocument({
      ...base,
      overrides: { price: "39800", tax: "課税", taxAmount: "1200" },
    });
    expect(tableLabels(taxed)).toContain("うち消費税");
    expect(tableRow(taxed, "うち消費税")).toBe("1200万円");

    const untaxed = buildSaleBuildingDocument({ ...base, overrides: { price: "39800", tax: "不課税" } });
    expect(tableLabels(untaxed)).not.toContain("うち消費税");
  });

  it("会社セクション(取引態様/報酬/広告/担当/取引士/特記)はスペック表の行にならず、フッターに出す", () => {
    const doc = buildSaleBuildingDocument({
      ...base,
      overrides: {
        transactionType: "専任媒介",
        compensation: "分かれ",
        adType: "広告可",
        staff: "山田",
        agent: "佐藤",
        specialNotes: "満室稼働中・利回り重視",
      },
    });
    const labels = tableLabels(doc);
    expect(labels).not.toContain("取引態様");
    expect(labels).not.toContain("報酬");
    expect(labels).not.toContain("特記事項");
    const json = JSON.stringify(doc.elements);
    expect(json).toContain("専任媒介");
    expect(json).toContain("山田");
    expect(json).toContain("満室稼働中・利回り重視");
  });

  it("用途地域は自動反映(zoningDistrict)+overridesの追加選択を併記する", () => {
    const doc = buildSaleBuildingDocument({ ...base, overrides: { useDistrict: ["近隣商業地域"] } });
    expect(tableRow(doc, "用途地域")).toBe("商業地域 / 近隣商業地域");
  });

  it("建蔽率/容積率/接道種別/接道幅員を自動反映する", () => {
    const doc = buildSaleBuildingDocument({ ...base, overrides: {} });
    expect(tableRow(doc, "建蔽率")).toBe("80％");
    expect(tableRow(doc, "容積率")).toBe("400％");
    expect(tableRow(doc, "接道種別")).toBe("公道");
    expect(tableRow(doc, "接道幅員")).toBe("6.0m");
  });

  it("接道幅員はoverride優先、無ければproperty.roadWidthから自動反映", () => {
    const overridden = buildSaleBuildingDocument({ ...base, overrides: { roadWidth: "8.0" } });
    expect(tableRow(overridden, "接道幅員")).toBe("8.0m");
    const auto = buildSaleBuildingDocument({ ...base, overrides: {} });
    expect(tableRow(auto, "接道幅員")).toBe("6.0m");
  });

  it("現況(occupancy)はoverride優先、無ければmapOccupancyStatusToMansionOccupancyの決定的デフォルト", () => {
    const auto = buildSaleBuildingDocument({
      ...base,
      property: { ...base.property, occupancyStatus: "vacant" },
      overrides: {},
    });
    expect(tableRow(auto, "現況")).toBe("空家");

    const overridden = buildSaleBuildingDocument({
      ...base,
      property: { ...base.property, occupancyStatus: "vacant" },
      overrides: { occupancy: "賃貸中" },
    });
    expect(tableRow(overridden, "現況")).toBe("賃貸中");
  });

  it.each([
    ["vacant", "空家"],
    ["occupied", "居住中"],
  ] as const)(
    "現況(%s): override省略の作成は、自動反映値をoverrideとして明示送信した場合と同じ現況(%s)になる",
    (occupancyStatus, expected) => {
      const withoutOverride = buildSaleBuildingDocument({
        ...base,
        property: { ...base.property, occupancyStatus },
        overrides: {},
      });
      const withAutoSeededOverride = buildSaleBuildingDocument({
        ...base,
        property: { ...base.property, occupancyStatus },
        overrides: { occupancy: mapOccupancyStatusToMansionOccupancy(occupancyStatus) },
      });
      expect(tableRow(withoutOverride, "現況")).toBe(expected);
      expect(tableRow(withoutOverride, "現況")).toBe(tableRow(withAutoSeededOverride, "現況"));
    },
  );

  it("deliveryTiming(旧キー・@deprecated)はdeliveryの別名として後方互換で使われる(deliveryが優先)", () => {
    const legacy = buildSaleBuildingDocument({ ...base, overrides: { deliveryTiming: "相談" } });
    expect(tableRow(legacy, "引渡時期")).toBe("相談");
    const both = buildSaleBuildingDocument({
      ...base,
      overrides: { delivery: "即時", deliveryTiming: "相談" },
    });
    expect(tableRow(both, "引渡時期")).toBe("即時");
  });

  it("土地面積は面積計測方式と合成される(公簿/実測)、未指定なら括弧無し、面積無しは空", () => {
    expect(
      tableRow(buildSaleBuildingDocument({ ...base, overrides: { landArea: "330.5", areaMethod: "実測" } }), "土地面積"),
    ).toBe("330.5㎡（実測）");
    expect(
      tableRow(buildSaleBuildingDocument({ ...base, overrides: { landArea: "330.5" } }), "土地面積"),
    ).toBe("330.5㎡");
    expect(
      tableRow(buildSaleBuildingDocument({ ...base, overrides: { areaMethod: "実測" } }), "土地面積"),
    ).toBe("");
  });

  it("セットバックはsetbackUnitと合成される、地上階/地下階は階付き", () => {
    const doc = buildSaleBuildingDocument({
      ...base,
      overrides: { setback: "0.5", setbackUnit: "m", aboveFloors: "5", basementFloors: "1" },
    });
    expect(tableRow(doc, "セットバック")).toBe("0.5m");
    expect(tableRow(doc, "地上階")).toBe("5階");
    expect(tableRow(doc, "地下階")).toBe("1階");
  });

  it("旧フラットキー(access/structure/builtYearMonth)はキー名互換で表に入る(キャッシュ済クライアント対応)", () => {
    const doc = buildSaleBuildingDocument({
      ...base,
      overrides: { access: "JR山手線 池袋駅 徒歩3分", structure: "RC", builtYearMonth: "2010年5月" },
    });
    expect(tableRow(doc, "交通")).toBe("JR山手線 池袋駅 徒歩3分");
    expect(tableRow(doc, "構造")).toBe("RC");
    expect(tableRow(doc, "築年月")).toBe("2010年5月");
  });

  it("価格にすでに「万円」が付いていても二重化しない／未入力ならprice要素は空文字", () => {
    expect(findEl(buildSaleBuildingDocument({ ...base, overrides: { price: "3億9,800万円" } }), "price")).toMatchObject({
      content: "3億9,800万円",
    });
    expect(findEl(buildSaleBuildingDocument({ ...base, overrides: {} }), "price")).toMatchObject({ content: "" });
  });

  it("写真3枚→image要素3、0枚→0。間取り画像を渡すと追加される", () => {
    const photos3 = [
      { fileUrl: "/uploads/1.jpg" },
      { fileUrl: "/uploads/2.jpg" },
      { fileUrl: "/uploads/3.jpg" },
    ];
    expect(imageCount(buildSaleBuildingDocument({ ...base, photos: photos3 }))).toBe(3);
    expect(imageCount(buildSaleBuildingDocument({ ...base, photos: [] }))).toBe(0);
    const withPlan = buildSaleBuildingDocument({ ...base, floorPlanImage: { fileUrl: "/uploads/plan.jpg" } });
    expect(withPlan.elements.some((e) => e.type === "image" && e.src === "/uploads/plan.jpg")).toBe(true);
  });

  it("会社定数(COMPANY)がフッターに含まれる", () => {
    const doc = buildSaleBuildingDocument({ ...base, overrides: {} });
    expect(JSON.stringify(doc.elements)).toContain("株式会社リガーレジャパン");
  });

  it("A4横でschema検証を通る（保存可能なdocument）", () => {
    const doc = buildSaleBuildingDocument({
      ...base,
      kind: "apartment",
      overrides: {
        price: "18000",
        tax: "課税",
        taxAmount: "600",
        totalUnits: "8",
        grossYield: "8.2",
        expectedIncome: "1476",
        landRight: "所有権",
        catchCopy: "満室稼働中",
        salesPoints: ["駅近", "利回り8%超"],
        landCategory: ["宅地"],
        roadDirections: ["南", "東"],
        cityPlanning: ["市街化区域"],
        areaZone: ["準防火"],
        transactionType: "専任媒介",
      },
    });
    expect(doc.page.orientation).toBe("landscape");
    expect(salesSheetDocumentSchema.safeParse(doc).success).toBe(true);
  });
});
