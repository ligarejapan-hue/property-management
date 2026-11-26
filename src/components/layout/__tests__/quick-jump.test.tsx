import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { QuickJumpResults, isQuickJumpShortcut } from "../quick-jump";
import type { QuickJumpResult } from "@/lib/quick-jump/search";

const read = (p: string) => readFileSync(path.resolve(process.cwd(), p), "utf-8").replace(/\r\n/g, "\n");

const page: QuickJumpResult = { kind: "page", key: "page:/deals", title: "取引", detail: "取引", href: "/deals", score: 100 };
const howto: QuickJumpResult = {
  kind: "howto",
  key: "howto:x",
  title: "鍵の本数を入れたい",
  detail: "取引の「物件」タブで入れます。",
  href: "/deals",
  hrefLabel: "取引の一覧へ",
  score: 50,
};
const doc: QuickJumpResult = { kind: "page", key: "page:/docs/manual.html", title: "取り扱いマニュアル", detail: "資料", href: "/docs/manual.html", external: true, score: 10 };

describe("QuickJumpResults", () => {
  it("空のときは例を出す", () => {
    expect(renderToStaticMarkup(<QuickJumpResults query="" results={[]} activeIndex={0} />)).toContain("例:");
  });
  it("見つからないときは言い換えとマニュアルを案内", () => {
    const html = renderToStaticMarkup(<QuickJumpResults query="あいう" results={[]} activeIndex={0} />);
    expect(html).toContain("見つかりませんでした");
    expect(html).toContain("/docs/manual.html");
  });
  it("画面とやりかたを並べ、選んでいる行に印", () => {
    const html = renderToStaticMarkup(<QuickJumpResults query="鍵" results={[howto, page, doc]} activeIndex={1} />);
    expect(html).toContain("やりかた");
    expect(html).toContain("取引の一覧へ");
    expect(html).toContain("取引の「物件」タブで入れます。");
    expect(html.match(/aria-selected="true"/g)?.length).toBe(1);
    expect(html).toContain('id="pm-quick-jump-0"');
    // 資料は別のタブで開く
    expect(html).toMatch(/href="\/docs\/manual.html" target="_blank" rel="noopener noreferrer"/);
  });
});

describe("isQuickJumpShortcut", () => {
  it("Ctrl+K と ⌘K だけ・日本語の確定中は除く", () => {
    expect(isQuickJumpShortcut({ key: "k", ctrlKey: true, metaKey: false })).toBe(true);
    expect(isQuickJumpShortcut({ key: "K", ctrlKey: false, metaKey: true })).toBe(true);
    expect(isQuickJumpShortcut({ key: "k", ctrlKey: false, metaKey: false })).toBe(false);
    expect(isQuickJumpShortcut({ key: "k", ctrlKey: true, metaKey: false, isComposing: true })).toBe(false);
    expect(isQuickJumpShortcut({ key: "K", ctrlKey: true, metaKey: false, shiftKey: true })).toBe(false);
    expect(isQuickJumpShortcut({ key: "k", ctrlKey: true, metaKey: false, altKey: true })).toBe(false);
  });
});

describe("置き場所", () => {
  it("頭の部分(どの画面にも出る)に役割を渡して置く", () => {
    expect(read("src/components/layout/header.tsx")).toContain("<QuickJump userRole={userRole} />");
  });
  it("打った言葉を外へ送らない・記録しない(fetch を使わない)", () => {
    const src = read("src/components/layout/quick-jump.tsx") + read("src/lib/quick-jump/search.ts");
    expect(src).not.toMatch(/\bfetch\(|localStorage|sendBeacon/);
  });
});
