import { describe, expect, it } from "vitest";
import type { FormDef } from "../forms/types";
import { clearFormValues, emptyFormValues, fitFormValues, formItems, visibleEntries } from "../forms/values";
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

describe("告知書のための項目の表の形(第2段階 段E)", () => {
  const F: FormDef = {
    key: "f",
    tabs: { key: "kind", label: "種類", choices: [{ value: "a", label: "甲" }, { value: "b", label: "乙" }] },
    entries: [
      { kind: "section", title: "甲だけの見出し", only: ["a"] },
      { kind: "item", key: "n1", label: "①雨漏り" },
      { kind: "item", key: "n1a", label: "", sub: true, multiple: true, choices: [{ value: "現在まで雨漏りを発見していない。", label: "現在まで雨漏りを発見していない。" }] },
      { kind: "item", key: "n1b", label: "修理工事：", sub: true, choices: [{ value: "未", label: "未" }, { value: "済", label: "済" }], fields: [{ key: "n1bY", label: "年", max: 10, after: true }, { key: "n1bM", label: "月頃", max: 10, after: true }] },
      { kind: "item", key: "n1c", label: "", sub: true, fields: [{ key: "n1cPlace", label: "箇所：", max: 20 }] },
      { kind: "item", key: "guide", label: "説明のページ", noPrint: true, choices: [{ value: "付ける", label: "付ける" }] },
    ],
  };
  it("見出しの出し分け・下の行は項目の欄を空ける・下線の後ろに字・「：」で終わる名前に「:」を重ねない・PDF に出さない欄", () => {
    const h = renderFormHtml(F, { ...emptyFormValues(F), n1bY: "2020" }).toString();
    expect(h).toContain("<h2>甲だけの見出し</h2>");
    expect(renderFormHtml(F, { ...emptyFormValues(F), kind: "b" }).toString()).not.toContain("甲だけの見出し");
    expect(h).toContain("<th style=\"width:30%\">①雨漏り</th>");
    expect(h).toMatch(/<th style="width:30%"><\/th><td>\s*<div>[^<]*<span class="form-choice">□ 現在まで雨漏りを発見していない。<\/span>/);
    expect(h).toContain("修理工事：");
    expect(h).toMatch(/<span class="form-text">2020<\/span>年/);
    expect(h).toMatch(/<span class="form-blank short"><\/span>月頃/);
    expect(h).toContain("箇所：<span class=\"form-blank\"></span>");
    expect(h).not.toContain("箇所：:");
    expect(h).not.toContain("説明のページ");
    expect(formValueRows(F, emptyFormValues(F)).map((r) => r.label)).toEqual([
      "甲だけの見出し", "①雨漏り 現在まで雨漏りを発見していない。", "①雨漏り 修理工事：", "①雨漏り 修理工事： 年", "①雨漏り 修理工事： 月頃", "①雨漏り 箇所：",
    ]);
  });
});

describe("小さな手直し(2026-10-30)", () => {
  const F: FormDef = {
    key: "f",
    tabs: { key: "kind", label: "種類", choices: [{ value: "a", label: "甲" }, { value: "b", label: "乙" }] },
    entries: [
      {
        kind: "item", key: "n5", label: "⑤リフォーム", choices: [{ value: "no", label: "実施していない" }, { value: "yes", label: "実施している" }, { value: "unknown", label: "不明" }],
        fields: [{ key: "n5Y", label: "年", max: 10, after: true }, { key: "n5M", label: "月頃", max: 10, after: true }],
        fieldsAt: { choice: "yes", open: "(", close: ")" },
      },
      { kind: "item", key: "n8", label: "", sub: true, choices: [{ value: "r", label: "報告書" }, { value: "s", label: "概要" }], around: ["（", "）"] },
      { kind: "item", key: "n98", label: "備考：", name: "備考（①〜⑬）" },
      { kind: "item", key: "n98a", label: "", sub: true, fields: [{ key: "n98aText", label: "", max: 100 }] },
      { kind: "item", key: "n99", label: "備考：", name: "備考（⑭〜⑳）" },
      { kind: "item", key: "n99a", label: "", sub: true, fields: [{ key: "n99aText", label: "", max: 100 }] },
    ],
  };
  const strip = (h: string) => h.replace(/<span class="form-blank short"><\/span>/g, "＿").replace(/<[^>]+>/g, "").replace(/\s+/g, "");

  it("年月の欄を「実施している」のすぐ後ろの括弧の中に出す(告知書 ⑤・書式の並び)", () => {
    const h = strip(renderFormHtml(F, emptyFormValues(F)).toString());
    expect(h).toContain("□実施している(＿年＿月頃)□不明");
    const filled = renderFormHtml(F, { ...emptyFormValues(F), n5: "yes", n5Y: "2020", n5M: "4" }).toString();
    expect(strip(filled)).toContain("■実施している(2020年4月頃)□不明");
  });

  it("選択肢を書式の括弧で1回だけ囲む(告知書 ⑧)", () => {
    const h = strip(renderFormHtml(F, emptyFormValues(F)).toString());
    expect(h).toContain("（□報告書□概要）");
    expect(h).not.toContain("（（");
    expect(h).not.toContain("））");
  });

  it("同じ字の見出しが2つあるときは、入力欄と Excel では name で見分ける(PDF は書式の字のまま)", () => {
    const rows = formValueRows(F, emptyFormValues(F)).map((r) => r.label);
    expect(rows).toContain("備考（①〜⑬）");
    expect(rows).toContain("備考（⑭〜⑳）");
    expect(new Set(rows).size).toBe(rows.length);
    const h = renderFormHtml(F, emptyFormValues(F)).toString();
    expect(h.match(/<th style="width:30%">備考：<\/th>/g)).toHaveLength(2);
    expect(h).not.toContain("⑭〜⑳");
  });

  it("古い控え・写しの合わない項目だけ初めの値に戻す(知らない鍵は捨てる・合う項目は残す)", () => {
    const base = { ...emptyFormValues(F), kind: "a", n98aText: "初めの値" };
    const r = fitFormValues(F, { kind: "b", n5: "yes", n5Y: "2020", n8: "消えた選択肢", n98aText: "x".repeat(101), old: "前の書式の欄", n99aText: 1 }, base);
    expect(r.values).toEqual({ ...base, kind: "b", n5: "yes", n5Y: "2020" });
    expect(r.dropped).toBe(true);
    expect(fitFormValues(F, { kind: "a", n5: "no" }, base)).toEqual({ values: { ...base, n5: "no" }, dropped: false });
    // 形の検査も通る(発行のときに 422 にならない)
    expect(formValuesSchema(F).safeParse(r.values).success).toBe(true);
    // いくつでも選べる欄は、合う値だけ残す
    const M: FormDef = { key: "m", entries: [{ kind: "item", key: "many", label: "x", multiple: true, choices: [{ value: "a", label: "あ" }] }] };
    expect(fitFormValues(M, { many: ["a", "z"] }, emptyFormValues(M))).toEqual({ values: { many: ["a"] }, dropped: true });
    // 壊れた値は全部初めの値
    expect(fitFormValues(M, null, emptyFormValues(M))).toEqual({ values: { many: [] }, dropped: true });
  });
});
