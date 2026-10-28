import { describe, expect, it } from "vitest";
import type { FormDef } from "../forms/types";
import { emptyFormValues, formItems } from "../forms/values";
import { formValuesSchema } from "../forms/schema";
import { formValueRows, renderFormHtml } from "../forms/render";

const FORM: FormDef = {
  key: "test",
  entries: [
    { kind: "section", title: "1. 試験の区切り" },
    { kind: "item", key: "yn", label: "有無<x>", choices: [{ value: "no", label: "無" }, { value: "yes", label: "有" }], fields: [{ key: "ynDetail", label: "内容", max: 20 }] },
    { kind: "item", key: "many", label: "いくつでも", multiple: true, choices: [{ value: "a", label: "あ" }, { value: "b", label: "い" }] },
    { kind: "section", title: "2. 注意" },
    { kind: "item", key: "warn", label: "非居住者", choices: [{ value: "no", label: "該当しない" }, { value: "yes", label: "該当する" }], note: { when: "yes", text: "源泉徴収が要ります" } },
    { kind: "item", key: "remarks", label: "注意事項", fields: [{ key: "remarksText", label: "内容", max: 50, lines: 3 }] },
  ],
};

describe("項目の表(設計 第2段階 §3.3)", () => {
  it("項目だけを並び順に取り出し、空の値を作る", () => {
    expect(formItems(FORM).map((i) => i.key)).toEqual(["yn", "many", "warn", "remarks"]);
    expect(emptyFormValues(FORM)).toEqual({ yn: null, ynDetail: null, many: [], warn: null, remarksText: null });
  });

  it("値の形: 無い鍵は空欄として読み、知らない値・知らない鍵・長すぎる書き込みは断る", () => {
    const s = formValuesSchema(FORM);
    expect(s.parse({})).toEqual(emptyFormValues(FORM));
    expect(s.parse({ yn: "yes", ynDetail: " 雨漏り ", many: ["b"] })).toEqual({ yn: "yes", ynDetail: "雨漏り", many: ["b"], warn: null, remarksText: null });
    expect(s.parse({ ynDetail: "  " }).ynDetail).toBeNull();
    for (const bad of [{ yn: "maybe" }, { many: ["z"] }, { many: "a" }, { other: 1 }, { ynDetail: "x".repeat(21) }]) {
      expect(s.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("PDF: 何も選ばなければ選択肢を □ で並べ、書き込み欄は下線の空欄", () => {
    const out = renderFormHtml(FORM, emptyFormValues(FORM)).toString();
    expect(out).toContain("<h2>1. 試験の区切り</h2>");
    expect(out).toContain("□ 無");
    expect(out).toContain("□ 有");
    expect(out).toContain("□ あ");
    expect(out).not.toContain("■");
    expect(out).toContain('<span class="form-blank"></span>');
    expect(out).not.toContain("源泉徴収が要ります");
    expect(out).toContain("有無&lt;x&gt;");
  });

  it("PDF: 選んだものは ■、書き込みは印字(エスケープ)、条件の注意書きは選んだときだけ", () => {
    const out = renderFormHtml(FORM, { ...emptyFormValues(FORM), yn: "yes", ynDetail: "<b>雨漏り</b>", many: ["a", "b"], warn: "yes" }).toString();
    expect(out).toContain("■ 有");
    expect(out).toContain("□ 無");
    expect(out).toContain("■ あ");
    expect(out).toContain("■ い");
    expect(out).toContain("&lt;b&gt;雨漏り&lt;/b&gt;");
    expect(out).toContain("源泉徴収が要ります");
  });

  it("Excel の行: 区切りは見出し、選んだものはその名前、空欄は null", () => {
    expect(formValueRows(FORM, { ...emptyFormValues(FORM), yn: "yes", many: ["a", "b"], remarksText: "メモ" })).toEqual([
      { label: "1. 試験の区切り", heading: true },
      { label: "有無<x>", value: "有" },
      { label: "有無<x> 内容", value: null },
      { label: "いくつでも", value: "あ・い" },
      { label: "2. 注意", heading: true },
      { label: "非居住者", value: null },
      { label: "注意事項 内容", value: "メモ" },
    ]);
  });
});
