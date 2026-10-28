import { describe, expect, it } from "vitest";
import type { FormDef } from "../forms/types";
import { clearFormValues, emptyFormValues, formItems, visibleEntries } from "../forms/values";
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

describe("項目の表のタブ(第2段階 段D・発注者の指示「同じページの中でタブで選択」)", () => {
  const TABBED: FormDef = {
    key: "tabbed",
    tabs: { key: "kind", label: "型", choices: [{ value: "a", label: "甲型" }, { value: "b", label: "乙型" }] },
    entries: [
      { kind: "item", key: "shared", label: "共通", choices: [{ value: "x", label: "ア" }] },
      { kind: "item", key: "onlyA", label: "甲だけ", only: ["a"], fields: [{ key: "onlyAText", label: "内容", max: 10 }] },
      { kind: "item", key: "onlyB", label: "乙だけ", only: ["b"], choices: [{ value: "1", label: "1" }, { value: "2", label: "2" }] },
    ],
  };
  it("空の値はタブの最初の選択肢・タブの鍵は形にも入る(知らない型は断る)", () => {
    expect(emptyFormValues(TABBED)).toEqual({ kind: "a", shared: null, onlyAText: null, onlyB: null });
    const s = formValuesSchema(TABBED);
    expect(s.parse({}).kind).toBe("a");
    expect(s.parse({ kind: "b", onlyB: "2" })).toMatchObject({ kind: "b", onlyB: "2" });
    expect(s.safeParse({ kind: "c" }).success).toBe(false);
    expect(s.safeParse({ kind: null }).success).toBe(false);
  });
  it("選んでいるタブの項目だけを出す(入力欄・PDF・Excel)", () => {
    const a = { ...emptyFormValues(TABBED), onlyAText: "甲の値", onlyB: "2" };
    expect(visibleEntries(TABBED, a).map((e) => (e.kind === "item" ? e.key : ""))).toEqual(["shared", "onlyA"]);
    expect(visibleEntries(TABBED, { ...a, kind: "b" }).map((e) => (e.kind === "item" ? e.key : ""))).toEqual(["shared", "onlyB"]);
    const h = renderFormHtml(TABBED, a).toString();
    expect(h).toContain("甲の値");
    expect(h).not.toContain("乙だけ");
    expect(formValueRows(TABBED, a).map((r) => r.label)).toEqual(["共通", "甲だけ 内容"]);
  });
  it("全部空欄に戻しても、選んでいるタブはそのまま", () => {
    expect(clearFormValues(TABBED, { kind: "b", shared: "x", onlyB: "1" })).toEqual({ kind: "b", shared: null, onlyAText: null, onlyB: null });
    expect(clearFormValues(FORM, { yn: "yes" })).toEqual(emptyFormValues(FORM));
  });
});
