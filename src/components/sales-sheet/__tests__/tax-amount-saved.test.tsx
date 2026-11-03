/**
 * 販売図面の作成の小窓: 物件に「消費税=課税」が保存してあれば、開いた時点で「うち消費税」の欄を出す
 * (2026-11-04 発注者指示)。選択が空なら保存済みの値で決め、手で選んだ値があればそちらで決める。
 * 区分・戸建・一棟で同じ動き。図面に入る値(build-document.ts)は変えない。
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import {
  FieldModelForm, computeBuildingAutoValues, computeHouseAutoValues, computeMansionAutoValues,
  type FieldModelValues, type SalesSheetTemplateKind,
} from "../SalesSheetCreateButton";
import { BUILDING_FIELDS, HOUSE_FIELDS, MANSION_FIELDS, type SheetField } from "@/lib/sales-sheet/field-model";

const saved = { saleTaxType: "課税", saleTaxAmount: "298", salePrice: "5980" };
const KINDS: { kind: SalesSheetTemplateKind; fields: readonly SheetField[]; compute: (d: typeof saved) => ReturnType<typeof computeMansionAutoValues> }[] = [
  { kind: "mansion", fields: MANSION_FIELDS, compute: (d) => computeMansionAutoValues(d) },
  { kind: "house", fields: HOUSE_FIELDS, compute: (d) => computeHouseAutoValues(d) },
  { kind: "building", fields: BUILDING_FIELDS, compute: (d) => computeBuildingAutoValues(d) },
];

function render(kind: SalesSheetTemplateKind, fields: readonly SheetField[], values: FieldModelValues, auto: ReturnType<typeof computeMansionAutoValues>) {
  return renderToStaticMarkup(
    createElement(FieldModelForm, {
      kind,
      sections: [["価格", fields.filter((f) => f.section === "価格")]],
      autoOnlyKeys: new Set<string>(),
      values,
      onChange: () => {},
      autoPreview: auto.preview,
      hints: auto.hints,
      controlSeeds: auto.controlSeeds,
    }),
  );
}

describe.each(KINDS)("うち消費税の欄($kind)", ({ kind, fields, compute }) => {
  it("課税が保存してあれば、選択が空でも欄を出し、空欄+自動反映(前回保存した値)の形にする", () => {
    const auto = compute(saved);
    expect(auto.controlSeeds).toEqual({ tax: "課税" });
    const html = render(kind, fields, {}, auto);
    expect(html).toContain("うち消費税");
    expect(html).toContain("298万円（前回保存した値です");
  });

  it("手で不課税を選んだら隠す", () => {
    expect(render(kind, fields, { tax: "不課税" }, compute(saved))).not.toContain("うち消費税");
  });

  it("保存が不課税・未保存なら、選択が空のあいだは出さない", () => {
    expect(render(kind, fields, {}, compute({ ...saved, saleTaxType: "不課税" }))).not.toContain("うち消費税");
    const none = compute({ ...saved, saleTaxType: "" });
    expect(none.controlSeeds).toEqual({});
    expect(render(kind, fields, {}, none)).not.toContain("うち消費税");
  });

  it("保存が不課税でも、手で課税を選べば出す", () => {
    expect(render(kind, fields, { tax: "課税" }, compute({ ...saved, saleTaxType: "不課税" }))).toContain("うち消費税");
  });
});
