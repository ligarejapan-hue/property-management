// 「物件データ編集」を「普段やる3つ」と「点検（ふだんは不要）」に分ける(発注者決定 2026-11-24・案1)。
// 経緯: 7画面とタブが多すぎて何をどうすればよいか分からない、という指摘。DM の宛先・通数に効く3つだけを
//   上に出し、残りは画面を消さずに「点検」の下へたたむ。件数はメニューに出さない(重い集計が毎画面で走るため)。
import { describe, it, expect } from "vitest";
import { SIDEBAR_GROUPS, visibleSidebar } from "../sidebar-model";
import { topNavEntries, OTHER_MENU_LABEL } from "../top-nav-model";

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
