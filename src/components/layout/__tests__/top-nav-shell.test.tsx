import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import TopNav from "../top-nav";

// 見た目の設定 段階3: 枠の組み込み・出し分けの CSS・上部ナビの描画。
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const css = read("src/app/globals.css");
const layout = read("src/components/layout/dashboard-layout.tsx");
const sidebar = read("src/components/layout/sidebar.tsx");
const header = read("src/components/layout/header.tsx");
const toggle = read("src/components/theme/theme-toggle.tsx");

describe("出し分け(globals.css)", () => {
  it("上部ナビを選んだ人は、広い画面(64rem 以上)だけ左サイドバーを出さない", () => {
    expect(css).toMatch(/@media \(min-width: 64rem\) \{\s*html\[data-layout="top"\] \[data-shell="sidebar"\] \{\s*display: none;/);
  });
  it("上部ナビは data-layout=top のときだけ出る", () => {
    expect(css).toContain('html:not([data-layout="top"]) [data-shell="topnav"] {\n  display: none;');
  });
  it("左サイドバーと上部ナビに印が付いている・上部ナビは狭い幅では出さない", () => {
    expect(sidebar).toContain('data-shell="sidebar"');
    const html = renderToStaticMarkup(<TopNav userRole="admin" currentPath="/home" />);
    expect(html).toContain('data-shell="topnav"');
    expect(html).toMatch(/class="hidden [^"]*lg:block/);
  });
});

describe("枠への組み込み", () => {
  it("ヘッダーの下・中身の上に上部ナビを置く(中身のページは同じ)", () => {
    const h = layout.indexOf("<Header ");
    const t = layout.indexOf("<TopNav ");
    const m = layout.indexOf("<main ");
    expect(h).toBeGreaterThan(-1);
    expect(t).toBeGreaterThan(h);
    expect(m).toBeGreaterThan(t);
  });
  it("「配置」は 設定 > 表示 で選ぶ(段階4 でヘッダーの選択欄から移した・スマホのメニューには出さない)", () => {
    expect(header).not.toContain("<ThemeToggle");
    expect(toggle).not.toContain("メニューの配置");
    expect(sidebar).not.toContain("withLayout");
  });
});

describe("上部ナビの描画", () => {
  it("項目は左メニューと同じ名前・現在地に aria-current と強調の色", () => {
    const html = renderToStaticMarkup(<TopNav userRole="admin" currentPath="/deals/1" />);
    expect(html).toContain('aria-label="メインメニュー"');
    const deals = html.match(/<a [^>]*href="\/deals"[^>]*>/)?.[0] ?? "";
    expect(deals).toContain('aria-current="page"');
    expect(deals).toContain("bg-side-active-bg");
    const home = html.match(/<a [^>]*href="\/home"[^>]*>/)?.[0] ?? "";
    expect(home).not.toContain("aria-current");
    expect(html).toContain("ホーム");
    expect(html).toContain("その他");
  });
  it("中が複数の柱は開閉ボタン(最初は閉じている)・現在地の柱は強調", () => {
    const html = renderToStaticMarkup(<TopNav userRole="admin" currentPath="/properties/abc" />);
    expect(html).toMatch(/<button[^>]*data-menu="prop"[^>]*aria-expanded="false"[^>]*class="[^"]*bg-side-active-bg/);
    expect(html).not.toContain('id="topnav-menu-prop"');
  });
  it("横スクロールにしない(幅が足りなければ折り返す)", () => {
    const html = renderToStaticMarkup(<TopNav userRole="admin" currentPath="/home" />);
    expect(html).toContain("flex flex-wrap");
    expect(html).not.toContain("overflow-x-auto");
  });
});

describe("実際の画面で見つけた点(1024px・大きめ)", () => {
  const top = read("src/components/layout/top-nav.tsx");
  it("長いメニューは画面の高さで止めて中を縦に送る(下の項目が切れて押せない、を防ぐ)", () => {
    expect(top).toContain("max-h-[calc(100dvh-9rem)]");
    expect(top).toContain("overflow-y-auto");
  });
  it("開閉の矢印は、動きを減らす設定では回さない", () => {
    expect(top).toContain("motion-reduce:transition-none");
  });
});

describe("ヘッダーが溢れない(1024px・左サイドバー・大きめでログアウトが画面の外へ出た)", () => {
  it("色・配置・文字の選択欄はヘッダーに並べない(段階4=利用者メニューと 設定 > 表示 へ)", () => {
    expect(toggle).not.toContain("data-layout-select");
    expect(css).not.toContain("data-layout-select");
    expect(header).toContain("<UserMenu ");
  });
  it("ログアウトの文字は md 以上・絵だけでも名前が読める", () => {
    expect(header).toContain('<span className="hidden md:inline">ログアウト</span>');
    expect(header).toContain('aria-label="ログアウト"');
  });
});
