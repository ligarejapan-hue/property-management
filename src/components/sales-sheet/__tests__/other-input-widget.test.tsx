import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { FieldModelForm, type FieldModelValues } from "../SalesSheetCreateButton";
import { LAND_FIELDS, type SheetField } from "@/lib/sales-sheet/field-model";

// [Task2] 「その他」を持つ select/multiselect 欄で、値がその他モードのとき自由入力欄
// （aria-label = フィールドラベル＋「その他」）が描画されることを検証する。
// 純関数の値ロジック（isOther/freeText の判定）自体は other-input.test.ts が担保するため、
// ここでは widget 結線＝静的構造のみを assert する（env=node・jsdom 非導入のため
// クリック/チェック等の対話は対象外＝他の *-dialog.test.tsx と同方式）。
//
// FieldModelForm は状態を持たない提示コンポーネント（values を親から受け取るだけ）のため、
// SalesSheetCreateDialog（内部 state が常に空で開始）を経由せず直接レンダリングして
// 「その他モード」の values を注入できる（SalesSheetCreateButton.tsx の FieldModelForm
// コメント参照：「SSR で構造を検証できるようにする」ための切り出し）。
function sectionsFor(...keys: string[]): (readonly [string, SheetField[]])[] {
  return [["s", LAND_FIELDS.filter((f) => keys.includes(f.key))]];
}

function renderForm(values: FieldModelValues, keys: string[]): string {
  return renderToStaticMarkup(
    createElement(FieldModelForm, {
      kind: "land",
      sections: sectionsFor(...keys),
      autoOnlyKeys: new Set<string>(),
      values,
      onChange: () => {},
      autoPreview: {},
      hints: {},
    }),
  );
}

describe("FieldModelWidget（その他 自由入力・[Task2]）", () => {
  describe("select（地勢＝TERRAIN にその他あり）", () => {
    it("値がリテラル「その他」のとき、自由入力欄（aria-label=ラベル＋その他）を描画する", () => {
      const html = renderForm({ terrain: "その他" }, ["terrain"]);
      expect(html).toMatch(/<input[^>]*aria-label="地勢（その他）"/);
    });

    it("options外の値（自由入力済み）でも自由入力欄を描画し、その値を value に反映する", () => {
      const html = renderForm({ terrain: "急傾斜" }, ["terrain"]);
      expect(html).toMatch(/<input[^>]*aria-label="地勢（その他）"[^>]*value="急傾斜"/);
    });

    it("options内の通常値では自由入力欄を描画しない", () => {
      const html = renderForm({ terrain: "平坦" }, ["terrain"]);
      expect(html).not.toMatch(/aria-label="地勢（その他）"/);
    });

    it("未入力（値なし）では自由入力欄を描画しない", () => {
      const html = renderForm({}, ["terrain"]);
      expect(html).not.toMatch(/aria-label="地勢（その他）"/);
    });
  });

  describe("multiselect（地目＝LAND_CATEGORY にその他あり）", () => {
    it("配列にリテラル「その他」を含むとき、自由入力欄を描画する", () => {
      const html = renderForm({ landCategory: ["宅地", "その他"] }, ["landCategory"]);
      expect(html).toMatch(/<input[^>]*aria-label="地目（その他）"/);
    });

    it("options外の要素（自由入力済み）を含むときも自由入力欄を描画し、その値を value に反映する", () => {
      const html = renderForm({ landCategory: ["宅地", "原野"] }, ["landCategory"]);
      expect(html).toMatch(/<input[^>]*aria-label="地目（その他）"[^>]*value="原野"/);
    });

    it("その他を含まない通常選択では自由入力欄を描画しない", () => {
      const html = renderForm({ landCategory: ["宅地", "田"] }, ["landCategory"]);
      expect(html).not.toMatch(/aria-label="地目（その他）"/);
    });

    it("未選択（値なし）では自由入力欄を描画しない", () => {
      const html = renderForm({}, ["landCategory"]);
      expect(html).not.toMatch(/aria-label="地目（その他）"/);
    });

    it("「その他」チェックボックス自体は他の選択肢と同じくチェックボックスとして描画される", () => {
      const html = renderForm({ landCategory: ["その他"] }, ["landCategory"]);
      expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*aria-label="その他"/);
    });
  });

  describe("guard: 「その他」を持たない欄は従来どおり（自由入力欄を出さない）", () => {
    it("select（物件種目＝PROPERTY_TYPE_LAND にその他なし）", () => {
      const html = renderForm({ propertyType: "売地" }, ["propertyType"]);
      expect(html).not.toContain("その他");
    });

    it("multiselect（用途地域＝USE_DISTRICT にその他なし）", () => {
      const html = renderForm({ useDistrict: ["第一種住居地域"] }, ["useDistrict"]);
      expect(html).not.toContain("その他");
    });
  });
});
