/**
 * タブ行 (UI一貫性 第3弾 ⑪)。
 *
 * 背景: border-b-2 のタブ行が複数画面で各自実装(active色・hover・aria無し)。
 * 規約: active=border-indigo-600 text-indigo-700(dark対応) / role=tab +
 * aria-selected / 折返し可(flex-wrap)。
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Tabs, tabPanelProps } from "../tabs";

const render = (el: React.ReactElement) => renderToStaticMarkup(el);
const TABS = [
  { key: "a", label: "氏名品質" },
  { key: "b", label: "連絡先" },
];

describe("Tabs", () => {
  it("active タブだけ indigo の下線+文字色(dark対応)", () => {
    const html = render(<Tabs idBase="t" tabs={TABS} active="a" onChange={() => {}} />);
    const btns = html.match(/<button[^>]*>/g) ?? [];
    expect(btns).toHaveLength(2);
    expect(btns[0]).toContain("border-indigo-600");
    expect(btns[0]).toContain("text-indigo-700");
    expect(btns[0]).toContain("dark:border-indigo-400");
    expect(btns[1]).toContain("border-transparent");
    expect(btns[1]).toContain("text-gray-500");
  });

  it("role=tablist / role=tab / aria-selected を持つ(手書き実装には無かった)", () => {
    const html = render(<Tabs idBase="t" tabs={TABS} active="b" onChange={() => {}} />);
    expect(html).toContain('role="tablist"');
    expect((html.match(/role="tab"/g) ?? []).length).toBe(2);
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aria-selected="false"');
  });

  it("タブとパネルが id で紐付く: id / aria-controls / tabPanelProps(@codex #406 R3 P2)", () => {
    const html = render(<Tabs idBase="t" tabs={TABS} active="a" onChange={() => {}} />);
    expect(html).toContain('id="t-tab-a"');
    expect(html).toContain('aria-controls="t-panel-a"');
    expect(html).toContain('aria-controls="t-panel-b"');
    // パネル側に貼る属性が対応する id を指す
    const panel = tabPanelProps("t", "a");
    expect(panel).toEqual({
      role: "tabpanel",
      id: "t-panel-a",
      "aria-labelledby": "t-tab-a",
    });
  });

  it("roving tabIndex: active だけ 0・他は -1(@codex #406 R1 P2)", () => {
    const html = render(<Tabs idBase="t" tabs={TABS} active="a" onChange={() => {}} />);
    const btns = html.match(/<button[^>]*>/g) ?? [];
    expect(btns[0]).toContain('tabindex="0"');
    expect(btns[1]).toContain('tabindex="-1"');
  });

  it("矢印キーの移動と選択を実装している(env=node のため存在をソースで固定)", () => {
    const src = readFileSync(
      join(process.cwd(), "src", "components", "ui", "tabs.tsx"),
      "utf8",
    );
    for (const key of ['"ArrowRight"', '"ArrowLeft"', '"Home"', '"End"']) {
      expect(src).toContain(`e.key === ${key}`);
    }
    expect(src).toContain("e.preventDefault()");
    expect(src).toContain(".focus()");
    expect(src).toContain("onKeyDown={handleKeyDown}");
  });

  it("type=button(form 内で誤 submit しない)・下線の枠(border-b)を持つ", () => {
    const html = render(<Tabs idBase="t" tabs={TABS} active="a" onChange={() => {}} />);
    expect((html.match(/type="button"/g) ?? []).length).toBe(2);
    expect(html).toContain("border-b border-gray-200");
  });
});
