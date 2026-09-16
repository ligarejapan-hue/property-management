import { describe, it, expect } from "vitest";
import { buildSaleHouseDocument } from "../build-document";
import { DETAIL_GROUPS } from "../main-detail-rows";
import { formatValue } from "../sheet-rows";
import type { SheetField } from "../field-model";

// [消費者向けひな型 仕上げ] 発注者判断待ちのうち、純関数で決まる3件のテスト。
//   ① 詳細表の「建蔽率/容積率」が枠内で1字折り返す → 主要表と同じ「・」区切りに揃える
//   ⑤ 価格の桁区切り("18800万円" → "18,800万円"。「億」は使わない=発注者判断 2026-09-16)
//   ⑥ 数字を含まない値に単位が付く("私道負担 なし㎡")

const base = {
  property: {
    address: "神奈川県横浜市港北区日吉4-5-6",
    layoutType: "4LDK",
    occupancyStatus: "vacant",
  },
  photos: [{ fileUrl: "/uploads/a.jpg" }],
};

const priceText = (doc: { elements: unknown[] }): string | undefined => {
  const el = (doc.elements as { id: string; content?: string }[]).find((e) => e.id === "price");
  return el?.content;
};

const field = (unit?: string): SheetField =>
  ({ key: "privateRoad", label: "私道負担", widget: "number", section: "土地", unit }) as SheetField;

describe("① 詳細表の項目名「建蔽率・容積率」", () => {
  it("詳細表の組は主要表と同じ「・」区切り(「/」だと最後の1字が折り返す)", () => {
    const labels = DETAIL_GROUPS.map((g) => g.label);
    expect(labels).toContain("建蔽率・容積率");
    expect(labels).not.toContain("建蔽率/容積率");
  });
});

describe("⑤ 価格の桁区切り", () => {
  it("4桁以上は3桁ごとにカンマを入れる", () => {
    const doc = buildSaleHouseDocument({ ...base, overrides: { price: "18800" } } as never);
    expect(priceText(doc)).toBe("18,800万円");
  });

  it("「億」表記にはしない(発注者判断)", () => {
    const doc = buildSaleHouseDocument({ ...base, overrides: { price: "10000" } } as never);
    expect(priceText(doc)).toBe("10,000万円");
  });

  it("3桁以下はそのまま", () => {
    const doc = buildSaleHouseDocument({ ...base, overrides: { price: "980" } } as never);
    expect(priceText(doc)).toBe("980万円");
  });

  it("既にカンマ入りで入力されても二重に付けない", () => {
    const doc = buildSaleHouseDocument({ ...base, overrides: { price: "3,480" } } as never);
    expect(priceText(doc)).toBe("3,480万円");
  });

  it("単位まで入力されていても二重に付けない(従来の契約を維持)", () => {
    const doc = buildSaleHouseDocument({ ...base, overrides: { price: "18800万円" } } as never);
    expect(priceText(doc)).toBe("18,800万円");
  });

  it("小数は整数部だけ区切る", () => {
    const doc = buildSaleHouseDocument({ ...base, overrides: { price: "18800.5" } } as never);
    expect(priceText(doc)).toBe("18,800.5万円");
  });

  it("数字以外(「応談」等)はそのまま通す", () => {
    const doc = buildSaleHouseDocument({ ...base, overrides: { price: "応談" } } as never);
    expect(priceText(doc)).toBe("応談万円");
  });

  it("空なら空のまま", () => {
    const doc = buildSaleHouseDocument({ ...base, overrides: { price: "" } } as never);
    expect(priceText(doc)).toBe("");
  });
});

describe("⑥ 数字を含まない値には単位を付けない", () => {
  it("「なし」に㎡を付けない", () => {
    expect(formatValue(field("㎡"), "なし")).toBe("なし");
  });

  it("「無」「－」「相談」も同じ", () => {
    expect(formatValue(field("㎡"), "無")).toBe("無");
    expect(formatValue(field("㎡"), "－")).toBe("－");
    expect(formatValue(field("m"), "相談")).toBe("相談");
  });

  it("数字を含む値には従来どおり単位を付ける", () => {
    expect(formatValue(field("㎡"), "5")).toBe("5㎡");
    expect(formatValue(field("㎡"), "12.34")).toBe("12.34㎡");
    expect(formatValue(field("㎡"), "約5")).toBe("約5㎡");
    expect(formatValue(field("㎡"), "５")).toBe("５㎡");
  });

  it("既に単位で終わっていれば付け直さない(従来の契約を維持)", () => {
    expect(formatValue(field("㎡"), "5㎡")).toBe("5㎡");
  });

  it("単位の無い項目は素通し", () => {
    expect(formatValue(field(undefined), "なし")).toBe("なし");
  });
});

describe("② 主要項目の表を枠の下まで伸ばす", () => {
  const tableEl = (doc: { elements: unknown[] }, id: string) =>
    (doc.elements as { id: string; type: string; style?: Record<string, unknown> }[]).find(
      (e) => e.id === id,
    );

  it("主要表は fillHeight=true(行の間隔を均等に広げて枠の底まで埋める)", () => {
    const doc = buildSaleHouseDocument(base as never);
    expect(tableEl(doc, "overview")?.style?.fillHeight).toBe(true);
  });

  it("詳細表は fillHeight を付けない(行数が少ないと間延びするため・Fix round 1 の裁定を維持)", () => {
    const doc = buildSaleHouseDocument(base as never);
    expect(tableEl(doc, "overview-detail-a")?.style?.fillHeight).toBeUndefined();
    expect(tableEl(doc, "overview-detail-b")?.style?.fillHeight).toBeUndefined();
  });
});
