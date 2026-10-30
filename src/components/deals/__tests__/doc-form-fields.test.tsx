import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DocFormFields } from "../doc-form-fields";
import type { FormDef } from "@/lib/deals/documents/forms/types";
import { DISCLOSURE_FORM } from "@/lib/deals/documents/forms/disclosure";
import { EQUIPMENT_FORM } from "@/lib/deals/documents/forms/equipment";

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
    // 下の行の読み上げには上の番号の行の名前を頭に付ける(2026-10-30)
    expect(out).toContain('aria-label="①雨漏り 修理工事： 年"');
    expect(out).toContain("説明のページ");
  });
  it("PDF に出さない設定の欄には「空欄」の選択肢を出さない(最終レビュー)", () => {
    const F: FormDef = { key: "f", entries: [{ kind: "item", key: "g", label: "説明のページ", noPrint: true, choices: [{ value: "付ける", label: "付ける" }, { value: "付けない", label: "付けない" }] }] };
    const out = renderToStaticMarkup(<DocFormFields form={F} values={{ g: "付ける" }} onChange={() => {}} />);
    expect(out).not.toContain("(空欄=□ で出す)");
  });
  it("空欄の選択肢の説明は実際の出方に合わせる(□ で出す書類/丸も □ も付けずに空けて出す書類・2026-10-30)", () => {
    const PLAIN: FormDef = { ...FORM, blankStyle: "plain" };
    const out = renderToStaticMarkup(<DocFormFields form={PLAIN} values={{}} onChange={() => {}} />);
    expect(out).toContain("(空欄=手書き用に空けて出す)");
    expect(out).not.toContain("□");
    expect(render({})).toContain("(空欄=□ で出す)");
  });
  it("下線の後ろに字を出す欄は、見本に書式の形(計＿台)を出す・読み上げにも前の字を入れる", () => {
    const F: FormDef = {
      key: "f",
      entries: [{ kind: "item", key: "ac", label: "冷暖房機", sub: true, choices: [{ value: "有", label: "有" }], fields: [{ key: "acCount", label: "台", pre: "計", max: 10, after: true }, { key: "acY", label: "年", max: 10, after: true }] }],
    };
    const out = renderToStaticMarkup(<DocFormFields form={F} values={{}} onChange={() => {}} />);
    expect(out).toContain('placeholder="計＿台"');
    expect(out).toContain('aria-label="冷暖房機 計 台"');
    expect(out).toContain('placeholder="＿年"');
    expect(out).toContain('aria-label="冷暖房機 年"');
  });
  it("入力欄の名前は name があればそれ(同じ字の見出しが2つある書式・PDF は書式の字のまま)", () => {
    const F: FormDef = { key: "f", entries: [{ kind: "item", key: "n98", label: "備考：", name: "備考（①〜⑬）", fields: [{ key: "n98Text", label: "", max: 10 }] }] };
    const out = renderToStaticMarkup(<DocFormFields form={F} values={{}} onChange={() => {}} />);
    expect(out).toContain("備考（①〜⑬）");
    expect(out).toContain('aria-label="備考（①〜⑬）"');
  });
  it("名前の無い下の行・付帯設備表の空欄の行も、読み上げの名前が空にならず上の項目の名前が付く(2026-10-30)", () => {
    for (const [form, kind] of [[DISCLOSURE_FORM, "house"], [DISCLOSURE_FORM, "unit"], [EQUIPMENT_FORM, "house"], [EQUIPMENT_FORM, "unit"]] as const) {
      const out = renderToStaticMarkup(<DocFormFields form={form} values={{ kind }} onChange={() => {}} />);
      const labels = [...out.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]);
      for (const l of labels) expect(l, `${form.key}/${kind}: 「${l}」`).toMatch(/^\S(.*\S)?$/);
      if (form === EQUIPMENT_FORM && kind === "house") expect(labels).toContain("給湯関係 空欄の行1");
      if (form === DISCLOSURE_FORM && kind === "house") expect(labels).toContain("③建物の不具合（傾き・腐食・不具合等） 箇所・状況：");
    }
  });
  it("空欄の値でも落ちない", () => {
    expect(() => render({})).not.toThrow();
  });
});
