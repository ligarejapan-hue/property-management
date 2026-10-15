import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SIDEBAR_GROUPS, LP_TOOL_PATHS, isNavItemActive } from "../sidebar-model";

const read = (p: string) => readFileSync(path.resolve(process.cwd(), p), "utf-8").replace(/\r\n/g, "\n");
const LP_PAGE = read("src/app/(dashboard)/lp/page.tsx");

// 画面すっきり化 第2回(発注者決定 2026-10-15): LPの道具3つ(売却DM設定・LPの写真・DMの種類)は
// 左メニューから外し、LPメニュー(/lp)の中だけに入口を置く。画面と URL はそのまま。
describe("LPの道具3つはLPメニューの中だけ", () => {
  const hrefs = SIDEBAR_GROUPS.flatMap((g) => g.items).map((i) => i.href);

  it("左メニューには出さない", () => {
    expect(LP_TOOL_PATHS).toEqual(["/admin/sale-dm-settings", "/admin/lp-assets", "/admin/dm-scenarios"]);
    for (const p of LP_TOOL_PATHS) expect(hrefs, p).not.toContain(p);
    expect(hrefs).toContain("/lp");
  });

  it("LPメニューの中には3つとも入口がある(=どこからも行けない画面にしない)", () => {
    for (const p of LP_TOOL_PATHS) expect(LP_PAGE).toContain(`href: "${p}"`);
  });

  it("3画面(とその下)ではLPメニューが光る=DM・LP関係の見出しが自動で開く", () => {
    for (const p of LP_TOOL_PATHS) {
      expect(isNavItemActive("/lp", p), p).toBe(true);
      expect(isNavItemActive("/lp", `${p}/abc`), p).toBe(true);
    }
    expect(isNavItemActive("/lp", "/lp")).toBe(true);
    // よく似た道(公開の /lp-assets/ や別の管理画面)では光らない
    expect(isNavItemActive("/lp", "/admin/lp-assets-x")).toBe(false);
    expect(isNavItemActive("/lp", "/admin/mail-settings")).toBe(false);
    expect(isNavItemActive("/lp", "/lp-assets/a.jpg")).toBe(false);
  });

  it("3画面からLPメニューへ戻れる", () => {
    for (const f of ["sale-dm-settings", "lp-assets", "dm-scenarios"]) {
      expect(read(`src/app/(dashboard)/admin/${f}/page.tsx`), f).toMatch(/<BackLink href="\/lp" to="LPメニュー"/);
    }
  });
});
