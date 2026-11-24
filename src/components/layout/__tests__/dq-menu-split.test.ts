// 「物件データ編集」を「普段やる3つ」と「点検（ふだんは不要）」に分ける(発注者決定 2026-11-24・案1)。
// 経緯: 7画面とタブが多すぎて何をどうすればよいか分からない、という指摘。DM の宛先・通数に効く3つだけを
//   上に出し、残りは画面を消さずに「点検」の下へたたむ。件数はメニューに出さない(重い集計が毎画面で走るため)。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SIDEBAR_GROUPS, visibleSidebar, isNavItemActive } from "../sidebar-model";
import { topNavEntries, OTHER_MENU_LABEL, isTopEntryActive } from "../top-nav-model";

const group = (key: string) => SIDEBAR_GROUPS.find((g) => g.key === key);

describe("物件データ編集=普段やる3つだけ", () => {
  it("謄本の名義の確認・重複候補・住所なし の順", () => {
    expect(group("dq")?.items.map((i) => i.href)).toEqual([
      "/properties/registry-owner-review",
      "/admin/owners/correction?tab=duplicate",
      "/admin/owners/correction?tab=address_null",
    ]);
  });

  it("名前は開いた先の画面・タブの名前と同じ(sidebar-page-title-parity.test.ts)", () => {
    expect(group("dq")?.items.map((i) => i.label)).toEqual(["謄本の名義の確認", "重複候補", "住所なし"]);
  });

  it("何をするかは一言説明で言う(DM に効くこと・3つの中身)", () => {
    expect(group("dq")?.label).toBe("物件データ編集");
    const d = group("dq")?.description ?? "";
    for (const w of ["DM", "同じ人をまとめる", "住所を補う"]) expect(d, w).toContain(w);
  });
});

describe("点検（ふだんは不要）=残りの画面をたたむ", () => {
  it("物件データ編集のすぐ下に、たためるグループとして置く", () => {
    const keys = SIDEBAR_GROUPS.map((g) => g.key);
    expect(keys.indexOf("dq-check")).toBe(keys.indexOf("dq") + 1);
    const g = group("dq-check");
    expect(g?.label).toBe("点検（ふだんは不要）");
    expect(g?.collapsible).toBe(true);
    expect(g?.pillar).toBeFalsy();
    expect(g?.description).toBeTruthy();
  });

  it("前からある画面は1つも消さない(全部この中にある)", () => {
    expect(group("dq-check")?.items.map((i) => i.href)).toEqual([
      "/admin/owners/correction",
      "/admin/owners/correction?tab=corporate_restore",
      "/admin/owners/correction?tab=registry_address",
      "/admin/owners/quality-audit",
      "/admin/owners/text-hygiene",
      "/admin/display-name-audit",
      "/admin/postal-code-audit",
    ]);
  });

  it("管理者だけに見える(前と同じ)", () => {
    for (const i of group("dq-check")?.items ?? []) expect(i.minRole, i.href).toBe("admin");
  });

  it("事務員には、謄本の名義の確認だけが出て、点検は出ない", () => {
    const groups = visibleSidebar("office_staff");
    expect(groups.find((g) => g.key === "dq")?.items.map((i) => i.href)).toEqual([
      "/properties/registry-owner-review",
    ]);
    expect(groups.find((g) => g.key === "dq-check")).toBeUndefined();
  });

  it("上部ナビの「その他」でも、物件データ編集の次に点検が並ぶ", () => {
    const other = topNavEntries(visibleSidebar("admin")).find((e) => e.key === "other");
    expect(other?.kind).toBe("menu");
    if (other?.kind !== "menu") return;
    expect(other.label).toBe(OTHER_MENU_LABEL);
    expect(other.sections.map((s) => s.label)).toEqual([
      "物件データ編集",
      "点検（ふだんは不要）",
      "システム管理",
      "資料",
    ]);
  });
});

// @codex #784 P2: タブへ飛ぶ項目が光らず、代わりに「点検」の所有者補正候補が光って「点検」が開いていた。
//   メニューは ?tab= まで見て現在地を決める。タブ専用の項目が当たるときは、タブを指定しない項目は光らせない。
describe("?tab= まで見て現在地を決める", () => {
  const C = "/admin/owners/correction";
  const active = (search: string) =>
    SIDEBAR_GROUPS.flatMap((g) => g.items)
      .filter((i) => isNavItemActive(i.href, C, "", search))
      .map((i) => i.href);

  it("重複候補のタブ → 重複候補だけが光る", () => {
    expect(active("?tab=duplicate")).toEqual([`${C}?tab=duplicate`]);
  });
  it("住所なしのタブ → 住所なしだけが光る", () => {
    expect(active("?tab=address_null")).toEqual([`${C}?tab=address_null`]);
  });
  it("ほかの値が付いていても tab が合えば光る(?tab=duplicate&dup=corporate_name)", () => {
    expect(active("?tab=duplicate&dup=corporate_name")).toEqual([`${C}?tab=duplicate`]);
  });
  it("法人番号紐づけ・住所の登記文字列のタブもそれぞれ光る", () => {
    expect(active("?tab=corporate_restore")).toEqual([`${C}?tab=corporate_restore`]);
    expect(active("?tab=registry_address")).toEqual([`${C}?tab=registry_address`]);
  });
  it("専用の項目が無いタブ(孤立)・タブ指定なし → 所有者補正候補が光る", () => {
    expect(active("?tab=orphan")).toEqual([C]);
    expect(active("")).toEqual([C]);
  });
  it("search を渡さない呼び出し(前からの呼び方)は前と同じ", () => {
    expect(isNavItemActive(C, C)).toBe(true);
    expect(isNavItemActive(`${C}?tab=duplicate`, C)).toBe(false);
  });
  it("左メニューで「物件データ編集」が開く側になる(点検は開かない)", () => {
    const groups = visibleSidebar("admin");
    const here = (key: string) =>
      groups.find((g) => g.key === key)!.items.some((i) => isNavItemActive(i.href, C, "", "?tab=duplicate"));
    expect(here("dq")).toBe(true);
    expect(here("dq-check")).toBe(false);
  });
  it("上部ナビの判定も search を受け取る", () => {
    const other = topNavEntries(visibleSidebar("admin")).find((e) => e.key === "other")!;
    expect(isTopEntryActive(other, C, "", "?tab=duplicate")).toBe(true);
  });
  it("外枠が URL の ? 以降を読んで、左メニューと上部ナビの両方へ渡す", () => {
    const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
    const layout = read("src/components/layout/dashboard-layout.tsx");
    expect(layout).toMatch(/useSearchParams/);
    expect(layout).toMatch(/<Suspense/);
    expect(layout).toMatch(/<Sidebar[^>]*currentSearch=\{search\}/);
    expect(layout).toMatch(/<TopNav[^>]*currentSearch=\{search\}/);
    expect(read("src/components/layout/sidebar.tsx")).toMatch(/isNavItemActive\(href, currentPath, hash, currentSearch\)/);
    expect(read("src/components/layout/top-nav.tsx")).toMatch(/isNavItemActive\(item\.href, currentPath, hash, currentSearch\)/);
    expect(read("src/components/layout/top-nav.tsx")).toMatch(/isTopEntryActive\(e, currentPath, hash, currentSearch\)/);
  });
});
