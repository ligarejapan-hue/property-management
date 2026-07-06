import { describe, it, expect } from "vitest";
import { buildSaleHouseDocument } from "../build-document";
import { salesSheetDocumentSchema } from "../document-schema";
import { mapOccupancyStatusToMansionOccupancy } from "../occupancy";

// [F2-B Task2] 売戸建を自社マイソク様式(buildSpecSheetDocument + HOUSE_FIELDS駆動)に
// 作り直したビルダーのテスト。build-land.test.ts/build-mansion.test.ts と同じ緩い型の
// ローカルヘルパーを使う。

const base = {
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
  photos: [{ fileUrl: "/uploads/a.jpg" }],
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

describe("buildSaleHouseDocument（自社マイソク様式・[F2-B Task2]）", () => {
  it("スペック表に主要行(用途地域/地目/建物面積)が入り、catch-band要素を含む", () => {
    const doc = buildSaleHouseDocument({
      ...base,
      overrides: {
        price: "5280",
        landCategory: ["宅地"],
        buildingArea: "95.60",
        catchCopy: "南向き陽当り良好",
      },
    });
    const labels = tableLabels(doc);
    expect(labels).toContain("用途地域");
    expect(labels).toContain("地目");
    expect(labels).toContain("建物面積(延べ)");
    expect(findEl(doc, "catch-band")).toMatchObject({ type: "shape", shape: "rect", fill: "#15324f" });
    expect(doc.elements.some((e) => e.type === "text" && e.content.includes("南向き陽当り良好"))).toBe(
      true,
    );
  });

  it("地目の複数選択は「 / 」で併記される", () => {
    const doc = buildSaleHouseDocument({
      ...base,
      overrides: { landCategory: ["宅地", "雑種地"] },
    });
    expect(tableRow(doc, "地目")).toBe("宅地 / 雑種地");
  });

  it("接道方向の複数選択も「 / 」で併記される", () => {
    const doc = buildSaleHouseDocument({
      ...base,
      overrides: { roadDirections: ["南", "東"] },
    });
    expect(tableRow(doc, "接道方向")).toBe("南 / 東");
  });

  it("課税ならうち消費税行が出て、不課税なら出ない", () => {
    const taxed = buildSaleHouseDocument({
      ...base,
      overrides: { price: "5280", tax: "課税", taxAmount: "480" },
    });
    expect(tableLabels(taxed)).toContain("うち消費税");
    expect(tableRow(taxed, "うち消費税")).toBe("480万円");

    const untaxed = buildSaleHouseDocument({
      ...base,
      overrides: { price: "5280", tax: "不課税" },
    });
    expect(tableLabels(untaxed)).not.toContain("うち消費税");
  });

  it("会社セクション(取引態様/報酬/広告/担当/取引士/特記)はスペック表の行にならず、フッターに出す", () => {
    const doc = buildSaleHouseDocument({
      ...base,
      overrides: {
        transactionType: "専任媒介",
        compensation: "分かれ",
        adType: "広告可",
        staff: "山田",
        agent: "佐藤",
        specialNotes: "南向き・車庫2台",
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
    expect(json).toContain("南向き・車庫2台");
  });

  it("用途地域は自動反映(zoningDistrict)+overridesの追加選択を併記する", () => {
    const doc = buildSaleHouseDocument({
      ...base,
      overrides: { useDistrict: ["近隣商業地域"] },
    });
    expect(tableRow(doc, "用途地域")).toBe("第一種低層住居専用地域 / 近隣商業地域");
  });

  it("建蔽率/容積率/接道種別/接道幅員/間取りを自動反映する", () => {
    const doc = buildSaleHouseDocument({ ...base, overrides: {} });
    expect(tableRow(doc, "建蔽率")).toBe("50％");
    expect(tableRow(doc, "容積率")).toBe("100％");
    expect(tableRow(doc, "接道種別")).toBe("公道");
    expect(tableRow(doc, "接道幅員")).toBe("4.0m");
    expect(tableRow(doc, "間取り")).toBe("4LDK");
  });

  it("接道幅員はoverride優先、無ければproperty.roadWidthから自動反映", () => {
    const overridden = buildSaleHouseDocument({ ...base, overrides: { roadWidth: "5.5" } });
    expect(tableRow(overridden, "接道幅員")).toBe("5.5m");
    const auto = buildSaleHouseDocument({ ...base, overrides: {} });
    expect(tableRow(auto, "接道幅員")).toBe("4.0m");
  });

  it("現況(occupancy)はoverride優先、無ければmapOccupancyStatusToMansionOccupancyの決定的デフォルト(vacant→空家)", () => {
    const auto = buildSaleHouseDocument({
      ...base,
      property: { ...base.property, occupancyStatus: "vacant" },
      overrides: {},
    });
    expect(tableRow(auto, "現況")).toBe("空家");

    const overridden = buildSaleHouseDocument({
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
    "現況(%s): overrideを省略した作成は、作成ダイアログが自動反映値をoverrideとして明示送信した場合と同じ現況(%s)になる",
    (occupancyStatus, expected) => {
      const withoutOverride = buildSaleHouseDocument({
        ...base,
        property: { ...base.property, occupancyStatus },
        overrides: {},
      });
      const withAutoSeededOverride = buildSaleHouseDocument({
        ...base,
        property: { ...base.property, occupancyStatus },
        overrides: { occupancy: mapOccupancyStatusToMansionOccupancy(occupancyStatus) },
      });
      expect(tableRow(withoutOverride, "現況")).toBe(expected);
      expect(tableRow(withoutOverride, "現況")).toBe(tableRow(withAutoSeededOverride, "現況"));
    },
  );

  it("deliveryTiming(旧キー・@deprecated)はdeliveryの別名として後方互換で使われる(deliveryが優先)", () => {
    const legacy = buildSaleHouseDocument({ ...base, overrides: { deliveryTiming: "相談" } });
    expect(tableRow(legacy, "引渡時期")).toBe("相談");
    const both = buildSaleHouseDocument({
      ...base,
      overrides: { delivery: "即時", deliveryTiming: "相談" },
    });
    expect(tableRow(both, "引渡時期")).toBe("即時");
  });

  it("土地面積は面積計測方式と合成される(120.5㎡（実測）)", () => {
    const doc = buildSaleHouseDocument({
      ...base,
      overrides: { landArea: "120.5", areaMethod: "実測" },
    });
    expect(tableRow(doc, "土地面積")).toBe("120.5㎡（実測）");
  });

  it("土地面積は面積計測方式が未選択なら括弧を付けない", () => {
    const doc = buildSaleHouseDocument({ ...base, overrides: { landArea: "120.5" } });
    expect(tableRow(doc, "土地面積")).toBe("120.5㎡");
  });

  it("土地面積が無ければ、面積計測方式の指定有無に関わらず空文字", () => {
    const doc = buildSaleHouseDocument({ ...base, overrides: { areaMethod: "実測" } });
    expect(tableRow(doc, "土地面積")).toBe("");
  });

  it("セットバックはsetbackUnitと合成される(0.5m / 3㎡)", () => {
    const withM = buildSaleHouseDocument({ ...base, overrides: { setback: "0.5", setbackUnit: "m" } });
    expect(tableRow(withM, "セットバック")).toBe("0.5m");
    const withSqm = buildSaleHouseDocument({ ...base, overrides: { setback: "3", setbackUnit: "㎡" } });
    expect(tableRow(withSqm, "セットバック")).toBe("3㎡");
  });

  it("セットバックが無ければ空文字", () => {
    const doc = buildSaleHouseDocument({ ...base, overrides: { setbackUnit: "m" } });
    expect(tableRow(doc, "セットバック")).toBe("");
  });

  it("新設項目(土地権利/私道負担/地勢/建築確認区分/再建築/駐車場/増改築年月/地上階/地下階/各階面積)がそのまま表に反映される", () => {
    const doc = buildSaleHouseDocument({
      ...base,
      overrides: {
        landRight: "所有権",
        privateRoad: "5",
        terrain: "平坦",
        buildingConfirm: "済",
        rebuild: "再建築可",
        parking: "有",
        renovYearMonth: "2020年3月",
        aboveFloors: "2",
        basementFloors: "0",
        floor1Area: "55.30",
        floor2Area: "40.30",
        floor3Area: "0",
      },
    });
    expect(tableRow(doc, "土地権利")).toBe("所有権");
    expect(tableRow(doc, "私道負担")).toBe("5㎡");
    expect(tableRow(doc, "地勢")).toBe("平坦");
    expect(tableRow(doc, "建築確認区分")).toBe("済");
    expect(tableRow(doc, "再建築")).toBe("再建築可");
    expect(tableRow(doc, "駐車場")).toBe("有");
    expect(tableRow(doc, "増改築年月")).toBe("2020年3月");
    expect(tableRow(doc, "地上階")).toBe("2階");
    expect(tableRow(doc, "地下階")).toBe("0階");
    expect(tableRow(doc, "1階面積")).toBe("55.30㎡");
    expect(tableRow(doc, "2階面積")).toBe("40.30㎡");
    expect(tableRow(doc, "3階面積")).toBe("0㎡");
  });

  it("表題は「売戸建」固定、価格はoverride×万円", () => {
    const doc = buildSaleHouseDocument({ ...base, overrides: { price: "5280" } });
    expect(findEl(doc, "heading")).toMatchObject({ content: "売戸建" });
    expect(findEl(doc, "price")).toMatchObject({ content: "5280万円" });
  });

  it("価格にすでに「万円」が付いていても二重化しない", () => {
    const doc = buildSaleHouseDocument({ ...base, overrides: { price: "5,280万円" } });
    expect(findEl(doc, "price")).toMatchObject({ content: "5,280万円" });
  });

  it("価格未入力ならprice要素のcontentは空文字", () => {
    const doc = buildSaleHouseDocument({ ...base, overrides: {} });
    expect(findEl(doc, "price")).toMatchObject({ content: "" });
  });

  it("写真3枚→image要素3、0枚→0", () => {
    const photos3 = [
      { fileUrl: "/uploads/1.jpg" },
      { fileUrl: "/uploads/2.jpg" },
      { fileUrl: "/uploads/3.jpg" },
    ];
    expect(imageCount(buildSaleHouseDocument({ ...base, photos: photos3 }))).toBe(3);
    expect(imageCount(buildSaleHouseDocument({ ...base, photos: [] }))).toBe(0);
  });

  it("間取り画像を渡すと image 要素が追加される(任意・未指定なら追加されない)", () => {
    const withPlan = buildSaleHouseDocument({
      ...base,
      floorPlanImage: { fileUrl: "/uploads/plan.jpg" },
    });
    const withoutPlan = buildSaleHouseDocument({ ...base });
    expect(withPlan.elements.some((e) => e.type === "image" && e.src === "/uploads/plan.jpg")).toBe(true);
    expect(withoutPlan.elements.some((e) => e.type === "image" && e.src === "/uploads/plan.jpg")).toBe(
      false,
    );
    expect(salesSheetDocumentSchema.safeParse(withPlan).success).toBe(true);
  });

  it("会社定数(COMPANY)がフッターに含まれる", () => {
    const doc = buildSaleHouseDocument({ ...base, overrides: {} });
    expect(JSON.stringify(doc.elements)).toContain("株式会社リガーレジャパン");
  });

  it("A4横でschema検証を通る（保存可能なdocument）", () => {
    const doc = buildSaleHouseDocument({
      ...base,
      overrides: {
        price: "5280",
        tax: "課税",
        taxAmount: "480",
        catchCopy: "南向き陽当り良好",
        salesPoints: ["リフォーム済", "車庫2台"],
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
