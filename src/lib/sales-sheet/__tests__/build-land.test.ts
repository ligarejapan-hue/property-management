import { describe, it, expect } from "vitest";
import { buildSaleLandDocument } from "../build-document";
import { salesSheetDocumentSchema } from "../document-schema";
import { mapOccupancyStatusToLandOccupancy } from "../occupancy";

// [F2-A Task3] 売土地を自社マイソク様式(buildSpecSheetDocument + LAND_FIELDS駆動)に
// 作り直したビルダーのテスト。build-mansion.test.ts と同じ緩い型のローカルヘルパーを使う。

const base = {
  property: {
    address: "東京都世田谷区上馬４丁目",
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

describe("buildSaleLandDocument（自社マイソク様式・[F2-A Task3]）", () => {
  it("スペック表に主要行(用途地域/地目/接道方向)が入り、catch-band要素を含む", () => {
    const doc = buildSaleLandDocument({
      ...base,
      overrides: {
        price: "3480",
        landCategory: ["宅地"],
        roadDirections: ["南"],
        catchCopy: "南西角地",
      },
    });
    const labels = tableLabels(doc);
    expect(labels).toContain("用途地域");
    expect(labels).toContain("地目");
    expect(labels).toContain("接道方向");
    expect(findEl(doc, "catch-band")).toMatchObject({ type: "shape", shape: "rect", fill: "#15324f" });
    expect(doc.elements.some((e) => e.type === "text" && e.content.includes("南西角地"))).toBe(true);
  });

  it("地目の複数選択は「 / 」で併記される", () => {
    const doc = buildSaleLandDocument({
      ...base,
      overrides: { landCategory: ["宅地", "雑種地"] },
    });
    expect(tableRow(doc, "地目")).toBe("宅地 / 雑種地");
  });

  it("地目に単一string(旧APIとの後方互換)を渡しても1件として表示される", () => {
    const doc = buildSaleLandDocument({
      ...base,
      overrides: { landCategory: "宅地" },
    });
    expect(tableRow(doc, "地目")).toBe("宅地");
  });

  it("消費税/うち消費税の行は存在しない(土地は非課税)", () => {
    const doc = buildSaleLandDocument({ ...base, overrides: { price: "3480" } });
    const labels = tableLabels(doc);
    expect(labels).not.toContain("消費税");
    expect(labels).not.toContain("うち消費税");
  });

  it("会社セクション(取引態様/報酬/広告/担当/取引士/特記)はスペック表の行にならず、フッターに出す", () => {
    const doc = buildSaleLandDocument({
      ...base,
      overrides: {
        transactionType: "仲介",
        compensation: "分かれ",
        adType: "広告可",
        staff: "山田",
        agent: "佐藤",
        specialNotes: "南西角地・整形地",
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
    expect(json).toContain("仲介");
    expect(json).toContain("山田");
    expect(json).toContain("南西角地・整形地");
  });

  it("用途地域は自動反映(zoningDistrict)+overridesの追加選択を併記する", () => {
    const doc = buildSaleLandDocument({
      ...base,
      overrides: { useDistrict: ["近隣商業地域"] },
    });
    expect(tableRow(doc, "用途地域")).toBe("第一種低層住居専用地域 / 近隣商業地域");
  });

  it("建蔽率/容積率/接道種別/接道幅員を自動反映する", () => {
    const doc = buildSaleLandDocument({ ...base, overrides: {} });
    expect(tableRow(doc, "建蔽率")).toBe("50％");
    expect(tableRow(doc, "容積率")).toBe("100％");
    expect(tableRow(doc, "接道種別")).toBe("公道");
    expect(tableRow(doc, "接道幅員")).toBe("4.0m");
  });

  it("接道幅員はoverride優先、無ければproperty.roadWidthから自動反映", () => {
    const overridden = buildSaleLandDocument({ ...base, overrides: { roadWidth: "5.5" } });
    expect(tableRow(overridden, "接道幅員")).toBe("5.5m");
    const auto = buildSaleLandDocument({ ...base, overrides: {} });
    expect(tableRow(auto, "接道幅員")).toBe("4.0m");
  });

  it("現況(occupancy)はoverride優先、無ければmapOccupancyStatusToLandOccupancyの決定的デフォルト(vacant→更地)", () => {
    const auto = buildSaleLandDocument({
      ...base,
      property: { ...base.property, occupancyStatus: "vacant" },
      overrides: {},
    });
    expect(tableRow(auto, "現況")).toBe("更地");

    const overridden = buildSaleLandDocument({
      ...base,
      property: { ...base.property, occupancyStatus: "vacant" },
      overrides: { occupancy: "上物有" },
    });
    expect(tableRow(overridden, "現況")).toBe("上物有");
  });

  it.each([
    ["vacant", "更地"],
    ["occupied", "上物有"],
  ] as const)(
    "現況(%s): overrideを省略した作成は、作成ダイアログが自動反映値をoverrideとして明示送信した場合と同じ現況(%s)になる",
    (occupancyStatus, expected) => {
      const withoutOverride = buildSaleLandDocument({
        ...base,
        property: { ...base.property, occupancyStatus },
        overrides: {},
      });
      const withAutoSeededOverride = buildSaleLandDocument({
        ...base,
        property: { ...base.property, occupancyStatus },
        overrides: { occupancy: mapOccupancyStatusToLandOccupancy(occupancyStatus) },
      });
      expect(tableRow(withoutOverride, "現況")).toBe(expected);
      expect(tableRow(withoutOverride, "現況")).toBe(tableRow(withAutoSeededOverride, "現況"));
    },
  );

  it("土地面積は面積計測方式と合成される(150.5㎡（実測）)", () => {
    const doc = buildSaleLandDocument({
      ...base,
      overrides: { landArea: "150.5", areaMethod: "実測" },
    });
    expect(tableRow(doc, "土地面積")).toBe("150.5㎡（実測）");
  });

  it("土地面積は面積計測方式が未選択なら括弧を付けない", () => {
    const doc = buildSaleLandDocument({ ...base, overrides: { landArea: "150.5" } });
    expect(tableRow(doc, "土地面積")).toBe("150.5㎡");
  });

  it("土地面積が無ければ、面積計測方式の指定有無に関わらず空文字", () => {
    const doc = buildSaleLandDocument({ ...base, overrides: { areaMethod: "実測" } });
    expect(tableRow(doc, "土地面積")).toBe("");
  });

  it("セットバックはsetbackUnitと合成される(0.5m / 3㎡)", () => {
    const withM = buildSaleLandDocument({ ...base, overrides: { setback: "0.5", setbackUnit: "m" } });
    expect(tableRow(withM, "セットバック")).toBe("0.5m");
    const withSqm = buildSaleLandDocument({ ...base, overrides: { setback: "3", setbackUnit: "㎡" } });
    expect(tableRow(withSqm, "セットバック")).toBe("3㎡");
  });

  it("セットバックが無ければ空文字", () => {
    const doc = buildSaleLandDocument({ ...base, overrides: { setbackUnit: "m" } });
    expect(tableRow(doc, "セットバック")).toBe("");
  });

  it("表題は「売土地」固定、価格はoverride×万円", () => {
    const doc = buildSaleLandDocument({ ...base, overrides: { price: "3480" } });
    expect(findEl(doc, "heading")).toMatchObject({ content: "売土地" });
    expect(findEl(doc, "price")).toMatchObject({ content: "3480万円" });
  });

  it("価格未入力ならprice要素のcontentは空文字", () => {
    const doc = buildSaleLandDocument({ ...base, overrides: {} });
    expect(findEl(doc, "price")).toMatchObject({ content: "" });
  });

  it("写真1枚→image要素1、0枚→0", () => {
    expect(imageCount(buildSaleLandDocument({ ...base, photos: [{ fileUrl: "/uploads/1.jpg" }] }))).toBe(1);
    expect(imageCount(buildSaleLandDocument({ ...base, photos: [] }))).toBe(0);
  });

  it("legacyな単数photoでも1枚のimage要素になる(後方互換)", () => {
    const doc = buildSaleLandDocument({
      property: base.property,
      photo: { fileUrl: "/uploads/legacy.jpg" },
      overrides: {},
    });
    expect(imageCount(doc)).toBe(1);
    expect(JSON.stringify(doc.elements)).toContain("/uploads/legacy.jpg");
  });

  it("会社定数(COMPANY)がフッターに含まれる", () => {
    const doc = buildSaleLandDocument({ ...base, overrides: {} });
    expect(JSON.stringify(doc.elements)).toContain("株式会社リガーレジャパン");
  });

  it("A4横でschema検証を通る（保存可能なdocument）", () => {
    const doc = buildSaleLandDocument({
      ...base,
      overrides: {
        price: "3480",
        catchCopy: "南西角地",
        salesPoints: ["整形地", "即引渡可"],
        landCategory: ["宅地"],
        roadDirections: ["南", "東"],
        cityPlanning: ["市街化区域"],
        areaZone: ["準防火"],
        transactionType: "仲介",
      },
    });
    expect(doc.page.orientation).toBe("landscape");
    expect(salesSheetDocumentSchema.safeParse(doc).success).toBe(true);
  });
});
