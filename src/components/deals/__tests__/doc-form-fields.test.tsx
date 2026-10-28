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
  it("空欄の値でも落ちない", () => {
    expect(() => render({})).not.toThrow();
  });
});
