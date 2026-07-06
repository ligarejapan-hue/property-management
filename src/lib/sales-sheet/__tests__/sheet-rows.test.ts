import { it, expect } from "vitest";
import { buildSheetRows, type SheetValues } from "../sheet-rows";
import type { SheetField } from "../field-model";

const fields: SheetField[] = [
  { key: "price", label: "価格", widget: "number", section: "価格", unit: "万円" },
  { key: "tax", label: "消費税", widget: "select", section: "価格", controlOnly: true },
  { key: "taxAmount", label: "うち消費税", widget: "number", section: "価格", unit: "万円", showWhen: { field: "tax", equals: "課税" } },
  { key: "useDistrict", label: "用途地域", widget: "multiselect", section: "土地" },
  { key: "remarks", label: "備考", widget: "text", section: "設備" },
];

it("number は単位付与、multiselect は併記、controlOnly は除外", () => {
  const values: SheetValues = {
    price: "6590", tax: "課税", taxAmount: "120",
    useDistrict: ["第一種住居地域", "近隣商業地域"], remarks: "角部屋",
  };
  const rows = buildSheetRows(fields, values);
  expect(rows).toEqual([
    { label: "価格", value: "6590万円" },
    { label: "うち消費税", value: "120万円" },
    { label: "用途地域", value: "第一種住居地域 / 近隣商業地域" },
    { label: "備考", value: "角部屋" },
  ]);
});

it("不課税なら うち消費税 行を出さない", () => {
  const rows = buildSheetRows(fields, { price: "4780", tax: "不課税" });
  expect(rows.map((r) => r.label)).not.toContain("うち消費税");
});

it("空値は空文字・単位を付けない", () => {
  const rows = buildSheetRows(fields, {});
  expect(rows.find((r) => r.label === "価格")?.value).toBe("");
  expect(rows.find((r) => r.label === "用途地域")?.value).toBe("");
});

it("すでに末尾が unit と一致する値は付け直さない(二重単位防止・万円)", () => {
  const priceFields: SheetField[] = [
    { key: "price", label: "価格", widget: "number", section: "価格", unit: "万円" },
  ];
  expect(buildSheetRows(priceFields, { price: "3,480万円" })[0].value).toBe("3,480万円");
  expect(buildSheetRows(priceFields, { price: "3480" })[0].value).toBe("3480万円");
});

it("すでに末尾が unit と一致する値は付け直さない(二重単位防止・m)", () => {
  const widthFields: SheetField[] = [
    { key: "roadWidth", label: "接道幅員", widget: "number", section: "法令", unit: "m" },
  ];
  expect(buildSheetRows(widthFields, { roadWidth: "5.5m" })[0].value).toBe("5.5m");
  expect(buildSheetRows(widthFields, { roadWidth: "5.5" })[0].value).toBe("5.5m");
});

it("unit ありでも空値は空文字のまま", () => {
  const priceFields: SheetField[] = [
    { key: "price", label: "価格", widget: "number", section: "価格", unit: "万円" },
  ];
  expect(buildSheetRows(priceFields, { price: "" })[0].value).toBe("");
  expect(buildSheetRows(priceFields, {})[0].value).toBe("");
});
