/**
 * タブ行 (UI一貫性 第3弾 ⑪)。
 *
 * 背景: border-b-2 のタブ行が複数画面で各自実装(active色・hover・aria無し)。
 * 規約: active=border-indigo-600 text-indigo-700(dark対応) / role=tab +
 * aria-selected / 折返し可(flex-wrap)。
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Tabs } from "../tabs";

const render = (el: React.ReactElement) => renderToStaticMarkup(el);
const TABS = [
  { key: "a", label: "氏名品質" },
  { key: "b", label: "連絡先" },
];

describe("Tabs", () => {
  it("active タブだけ indigo の下線+文字色(dark対応)", () => {
    const html = render(<Tabs tabs={TABS} active="a" onChange={() => {}} />);
    const btns = html.match(/<button[^>]*>/g) ?? [];
    expect(btns).toHaveLength(2);
    expect(btns[0]).toContain("border-indigo-600");
    expect(btns[0]).toContain("text-indigo-700");
    expect(btns[0]).toContain("dark:border-indigo-400");
    expect(btns[1]).toContain("border-transparent");
    expect(btns[1]).toContain("text-gray-500");
  });

  it("role=tablist / role=tab / aria-selected を持つ(手書き実装には無かった)", () => {
    const html = render(<Tabs tabs={TABS} active="b" onChange={() => {}} />);
    expect(html).toContain('role="tablist"');
    expect((html.match(/role="tab"/g) ?? []).length).toBe(2);
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aria-selected="false"');
  });

  it("type=button(form 内で誤 submit しない)・下線の枠(border-b)を持つ", () => {
    const html = render(<Tabs tabs={TABS} active="a" onChange={() => {}} />);
    expect((html.match(/type="button"/g) ?? []).length).toBe(2);
    expect(html).toContain("border-b border-gray-200");
  });
});
