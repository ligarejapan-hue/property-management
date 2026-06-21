import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "page.tsx"), "utf8");

describe("properties/page.tsx モバイル UI (M1)", () => {
  // §8-2 フィルタ折りたたみ
  it("§8-2: showFilters の state が存在する", () => {
    expect(src).toContain("showFilters");
  });
  it("§8-2: モバイル専用トグルに md:hidden がある", () => {
    expect(src).toContain("md:hidden");
  });
  it("§8-2: フィルタ panel の条件表示に md:flex がある", () => {
    expect(src).toContain("md:flex");
  });

  // §8-3 ページネーション縦積み → 横
  it("§8-3: ページネーションに flex-col がある", () => {
    expect(src).toContain("flex-col");
  });
  it("§8-3: ページネーションに sm:flex-row がある", () => {
    expect(src).toContain("sm:flex-row");
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
