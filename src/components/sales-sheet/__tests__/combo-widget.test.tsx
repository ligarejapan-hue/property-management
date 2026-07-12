import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { FieldModelForm, type FieldModelValues } from "../SalesSheetCreateButton";
import { MANSION_FIELDS, type SheetField } from "@/lib/sales-sheet/field-model";
import { COMPENSATION } from "@/lib/sales-sheet/option-master";

// [Task3] 報酬(compensation)は widget:"combo" — プリセット選択肢を提示しつつ自由入力も許す
// コンボボックス。<input list=…> + 対応する <datalist> として描画されることを検証する
// （対話は対象外・SSR構造assert、other-input-widget.test.tsx と同方式）。

function sectionsFor(...keys: string[]): (readonly [string, SheetField[]])[] {
  return [["s", MANSION_FIELDS.filter((f) => keys.includes(f.key))]];
}

function renderForm(values: FieldModelValues): string {
  return renderToStaticMarkup(
    createElement(FieldModelForm, {
      kind: "mansion",
      sections: sectionsFor("compensation"),
      autoOnlyKeys: new Set<string>(),
      values,
      onChange: () => {},
      autoPreview: {},
      hints: {},
    }),
  );
}

describe("FieldModelWidget（報酬 combo・[Task3]）", () => {
  it("<input list=…> として描画され、list 属性が対応する <datalist id=…> を指す", () => {
    const html = renderForm({});
    const inputMatch = html.match(/<input[^>]*aria-label="報酬"[^>]*\blist="([^"]+)"[^>]*>/);
    expect(inputMatch).not.toBeNull();
    const listId = inputMatch![1];
    expect(listId).not.toBe("");
    expect(html).toContain(`<datalist id="${listId}">`);
  });

  it("<select> ではなく <input> として描画される（select タグを含まない）", () => {
    const html = renderForm({});
    expect(html).not.toContain("<select");
  });

  it("datalist は COMPENSATION の全選択肢を <option> として含む", () => {
    const html = renderForm({});
    for (const opt of COMPENSATION) {
      expect(html).toContain(`<option value="${opt}">`);
    }
  });

  it("options外の自由入力文字列も value にそのまま反映される（自由記入可）", () => {
    const html = renderForm({ compensation: "税込3.5%+3万円" });
    expect(html).toContain('aria-label="報酬"');
    expect(html).toMatch(/<input[^>]*aria-label="報酬"[^>]*value="税込3\.5%\+3万円"/);
  });

  it("未入力時は value=\"\" で描画される", () => {
    const html = renderForm({});
    expect(html).toMatch(/<input[^>]*aria-label="報酬"[^>]*value=""/);
  });
});
