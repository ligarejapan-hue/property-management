import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { QuickJumpResults, isQuickJumpShortcut, quickJumpPlacement } from "../quick-jump";
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
  manualHref: "/docs/manual.html#deal-keys",
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
    // 答えの下にマニュアルの節へのリンク(別のタブ)
    expect(html).toMatch(/href="\/docs\/manual.html#deal-keys" target="_blank" rel="noopener noreferrer"[^>]*>.*マニュアルで見る/);
    expect(html.match(/マニュアルで見る/g)?.length).toBe(1);
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
  it("外枠(どの画面にも出る)に役割を渡して置く・頭の部分からは外した", () => {
    expect(read("src/components/layout/dashboard-layout.tsx")).toContain('<QuickJump userRole={userRole} currentPath={pathname ?? ""} />');
    expect(read("src/components/layout/header.tsx")).not.toContain("QuickJump");
  });
  it("右下に浮かぶ「困ったらここ」・画面を覆わない箱", () => {
    const src = read("src/components/layout/quick-jump.tsx");
    expect(src).toContain('normal: "right-4 bottom-4 items-end"');
    expect(src).toContain("困ったらここ");
    expect(src).not.toContain("ModalShell");
    expect(src).toContain("if (hidden) return null;");
  });
  it("置き場所: 地図の画面には出さない・査定書の確認は上げる・ほかは右下", () => {
    expect(quickJumpPlacement("/field-survey/map")).toBe("hidden");
    expect(quickJumpPlacement("/field-survey/sessions")).toBe("hidden");
    expect(quickJumpPlacement("/field-survey/sessions/abc")).toBe("hidden");
    expect(quickJumpPlacement("/field-survey/candidates")).toBe("normal");
    expect(quickJumpPlacement("/properties/p1/appraisal-decks/d1")).toBe("raised");
    expect(quickJumpPlacement("/properties/p1")).toBe("normal");
    expect(quickJumpPlacement("/deals")).toBe("normal");
  });
  it("打った言葉を外へ送らない・記録しない(fetch を使わない)", () => {
    const src = read("src/components/layout/quick-jump.tsx") + read("src/lib/quick-jump/search.ts");
    expect(src).not.toMatch(/\bfetch\(|localStorage|sendBeacon/);
  });
});
