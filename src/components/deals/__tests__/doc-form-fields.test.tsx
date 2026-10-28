import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DocFormFields } from "../doc-form-fields";
import type { FormDef } from "@/lib/deals/documents/forms/types";

const FORM: FormDef = {
  key: "t",
  entries: [
    { kind: "section", title: "1. 区切り" },
    { kind: "item", key: "yn", label: "有無", choices: [{ value: "no", label: "無" }, { value: "yes", label: "有" }], fields: [{ key: "ynDetail", label: "内容", max: 20 }] },
    { kind: "item", key: "many", label: "いくつでも", multiple: true, choices: [{ value: "a", label: "あ" }, { value: "b", label: "い" }] },
    { kind: "item", key: "remarks", label: "注意事項", fields: [{ key: "remarksText", label: "内容", max: 50, lines: 3 }] },
  ],
};
const render = (values: Record<string, unknown>) => renderToStaticMarkup(<DocFormFields form={FORM} values={values} onChange={() => {}} />);

describe("項目の表から入力欄を描く(設計 第2段階 §3.3)", () => {
  it("区切りの見出し・1つ選ぶ=セレクト(空欄の選択肢つき)・いくつでも=チェックボックス・書き込み欄", () => {
    const out = render({ yn: "yes", ynDetail: "雨漏り", many: ["b"], remarksText: null });
    expect(out).toContain("1. 区切り");
    expect(out).toContain('aria-label="有無"');
    expect(out).toContain("(空欄=□ で出す)");
    expect(out).toMatch(/<option value="yes" selected="">有<\/option>/);
    expect(out).toMatch(/<input type="checkbox"[^>]*checked=""[^>]*\/?>い/);
    expect(out).not.toMatch(/<input type="checkbox"[^>]*checked=""[^>]*\/?>あ/);
    expect(out).toContain('aria-label="有無 内容"');
    expect(out).toContain('value="雨漏り"');
    expect(out).toContain("<textarea");
    expect(out).toContain('maxLength="50"');
  });
  it("タブ: 一番上に型のタブ・選んだタブだけ選択中・そのタブの項目だけ描く", () => {
    const TABBED: FormDef = {
      key: "tabbed",
      tabs: { key: "kind", label: "型", choices: [{ value: "a", label: "甲型" }, { value: "b", label: "乙型" }] },
      entries: [
        { kind: "item", key: "onlyA", label: "甲だけの欄", only: ["a"], fields: [{ key: "onlyAText", label: "内容", max: 10 }] },
        { kind: "item", key: "onlyB", label: "乙だけの欄", only: ["b"], fields: [{ key: "onlyBText", label: "内容", max: 10 }] },
      ],
    };
    const out = renderToStaticMarkup(<DocFormFields form={TABBED} values={{ kind: "b" }} onChange={() => {}} />);
    expect(out).toContain('role="tablist"');
    expect(out).toContain('aria-label="型"');
    expect(out).toMatch(/<button[^>]*role="tab"[^>]*aria-selected="true"[^>]*>乙型<\/button>/);
    expect(out).toMatch(/<button[^>]*role="tab"[^>]*aria-selected="false"[^>]*>甲型<\/button>/);
    expect(out.indexOf('role="tablist"')).toBeLessThan(out.indexOf("乙だけの欄"));
    expect(out).toContain("乙だけの欄");
    expect(out).not.toContain("甲だけの欄");
  });
  it("下の行は字下げ・下線の後ろの字の欄も入力できる・PDF に出さない欄も入力欄には出す", () => {
    const F: FormDef = {
      key: "f",
      entries: [
        { kind: "item", key: "n1", label: "①雨漏り" },
        { kind: "item", key: "n1b", label: "修理工事：", sub: true, choices: [{ value: "未", label: "未" }], fields: [{ key: "n1bY", label: "年", max: 10, after: true }] },
        { kind: "item", key: "guide", label: "説明のページ", noPrint: true, choices: [{ value: "付ける", label: "付ける" }] },
      ],
    };
    const out = renderToStaticMarkup(<DocFormFields form={F} values={{}} onChange={() => {}} />);
    expect(out).toContain("①雨漏り");
    expect(out).toMatch(/<div class="[^"]*ml-4[^"]*">[\s\S]*修理工事：/);
    expect(out).toContain('aria-label="修理工事： 年"');
    expect(out).toContain("説明のページ");
  });
  it("空欄の値でも落ちない", () => {
    expect(() => render({})).not.toThrow();
  });
});
