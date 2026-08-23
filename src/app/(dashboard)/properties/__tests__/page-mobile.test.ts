import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "page.tsx"), "utf8");

describe("properties/page.tsx モバイル UI (M1)", () => {
  // §8-2 フィルタ折りたたみ
  // UI一貫性 第1弾(5)で「モバイルだけ全体を畳む」から「全サイズで詳細条件を畳む」へ
  // 置き換えた(常時表示は検索・DM判断・担当者・リセットの短い1行だけ=モバイルでも短い)。
  it("§8-2: 詳細条件の折りたたみ state(advancedOpen)が存在する", () => {
    expect(src).toContain("advancedOpen");
  });
  it("§8-2: 詳細条件トグルがあり適用件数を出す", () => {
    expect(src).toContain("詳細条件");
    expect(src).toContain("件適用中");
  });
  it("§8-2: 詳細ブロックは advancedOpen のときだけ描画される", () => {
    expect(src).toContain("{advancedOpen && (");
  });

  // §8-3 ページネーション縦積み → 横
  it("§8-3: ページネーションに flex-col がある", () => {
    expect(src).toContain("flex-col");
  });
  it("§8-3: ページネーションは共通 Pagination(タップ寸法44pxは部品側で担保)", () => {
    // 第2弾⑨で共通部品化。flex-wrap での折返し・min-h-[44px] は
    // src/components/ui/__tests__/pagination.test.tsx が固定している。
    expect(src).toContain("<Pagination");
    expect(src).toContain('from "@/components/ui/pagination"');
  });

  // §8-4 行クリック遷移 + 誤遷移防止
  it("§8-4: データ行に cursor-pointer がある", () => {
    expect(src).toContain("cursor-pointer");
  });
  it("§8-4: router.push で物件詳細に遷移する", () => {
    expect(src).toContain("router.push");
  });
  it("§8-4: stopPropagation で誤遷移を防止している", () => {
    expect(src).toContain("stopPropagation");
  });
  it("§8-4: 修飾クリック (metaKey) のガードがある", () => {
    expect(src).toContain("e.metaKey");
  });
  it("§8-4: 修飾クリック (ctrlKey) のガードがある", () => {
    expect(src).toContain("e.ctrlKey");
  });
  it("§8-4: リンク/インタラクティブ要素由来クリックのガードがある", () => {
    expect(src).toContain('closest("a, button, input, label, select, textarea")');
  });
  it("§8-4: defaultPrevented チェックがある", () => {
    expect(src).toContain("e.defaultPrevented");
  });

  // §8-7 上下余白
  it("§8-7: ページ上部に pt-2 がある", () => {
    expect(src).toContain("pt-2");
  });
  it("§8-7: ページネーション/下部に pb-8 以上の余白がある", () => {
    const hasPb = src.includes("pb-8") || src.includes("pb-9") || src.includes("pb-10") || src.includes("pb-12");
    expect(hasPb).toBe(true);
  });

  // 回帰防止: ダークモード段階 2a の dark: クラス保持
  it("回帰: dark:hover:bg-gray-800 が依然存在する", () => {
    expect(src).toContain("dark:hover:bg-gray-800");
  });
  it("回帰: dark:bg-gray-900 が依然存在する", () => {
    expect(src).toContain("dark:bg-gray-900");
  });
  it("回帰: dark:text-gray-100 が依然存在する", () => {
    expect(src).toContain("dark:text-gray-100");
  });
});
