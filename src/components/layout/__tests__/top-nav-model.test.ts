import { describe, it, expect } from "vitest";
import { topNavEntries, isTopEntryActive, menuAlignRight } from "../top-nav-model";
import { visibleSidebar, SIDEBAR_GROUPS } from "../sidebar-model";

// 見た目の設定 段階3: 上部ナビの並びは左メニューと同じ定義(SIDEBAR_GROUPS)から作る。
describe("topNavEntries", () => {
  it("管理者: ホーム・柱・その他 の順。中が1つの柱はそのままリンク、複数ならメニュー", () => {
    const entries = topNavEntries(visibleSidebar("admin"));
    expect(entries.map((e) => e.label)).toEqual([
      "ホーム",
      "反響受付",
      "物件",
      "取引",
      "現地調査",
      "DM・LP関係",
      "物件データ取り込み",
      "販売図面",
      "その他",
    ]);
    const deal = entries.find((e) => e.label === "取引")!;
    expect(deal.kind).toBe("link");
    const prop = entries.find((e) => e.label === "物件")!;
    expect(prop.kind).toBe("menu");
  });

  it("柱でないグループ(物件データ編集・システム管理・資料)は「その他」の中に見出しごと並ぶ", () => {
    const other = topNavEntries(visibleSidebar("admin")).find((e) => e.label === "その他")!;
    expect(other.kind).toBe("menu");
    if (other.kind !== "menu") return;
    expect(other.sections.map((s) => s.label)).toEqual(["物件データ編集", "システム管理", "資料"]);
  });

  it("左メニューに出る項目は、上部ナビにも全部・1回ずつ出る(役割ごと)", () => {
    for (const role of ["admin", "office_staff", "field_staff"]) {
      const groups = visibleSidebar(role);
      const side = groups.flatMap((g) => g.items.map((i) => i.href)).sort();
      const top = topNavEntries(groups)
        .flatMap((e) => (e.kind === "link" ? [e.item.href] : e.sections.flatMap((s) => s.items.map((i) => i.href))))
        .sort();
      expect(top).toEqual(side);
    }
  });

  it("現地担当: 見えない柱は出ない・「その他」は資料だけ", () => {
    const entries = topNavEntries(visibleSidebar("field_staff"));
    expect(entries.map((e) => e.label)).not.toContain("DM・LP関係");
    const other = entries.find((e) => e.label === "その他")!;
    if (other.kind !== "menu") throw new Error("menu expected");
    expect(other.sections.map((s) => s.label)).toEqual(["資料"]);
  });

  it("定義を変えずに作る(左メニューの定義を書き換えない)", () => {
    const before = JSON.stringify(SIDEBAR_GROUPS.map((g) => [g.key, g.items.length]));
    topNavEntries(visibleSidebar("admin"));
    expect(JSON.stringify(SIDEBAR_GROUPS.map((g) => [g.key, g.items.length]))).toBe(before);
  });
});

describe("isTopEntryActive(現在地)", () => {
  const entries = topNavEntries(visibleSidebar("admin"));
  const byLabel = (l: string) => entries.find((e) => e.label === l)!;

  it("物件の詳細を見ているときは「物件」が光る・ホームは光らない", () => {
    expect(isTopEntryActive(byLabel("物件"), "/properties/abc")).toBe(true);
    expect(isTopEntryActive(byLabel("ホーム"), "/properties/abc")).toBe(false);
  });

  it("中が1つの柱(取引)は、その画面の下でも光る", () => {
    expect(isTopEntryActive(byLabel("取引"), "/deals/123/funding-plan")).toBe(true);
  });

  it("ユーザー管理を見ているときは「その他」が光る", () => {
    expect(isTopEntryActive(byLabel("その他"), "/admin/users")).toBe(true);
    expect(isTopEntryActive(byLabel("物件"), "/admin/users")).toBe(false);
  });
});

describe("menuAlignRight(開いたメニューを右にそろえるか)", () => {
  it("右に入りきるなら左そろえ・入りきらないなら右そろえ", () => {
    expect(menuAlignRight(300, 16, 1440)).toBe(false);
    expect(menuAlignRight(1200, 16, 1440)).toBe(true);
  });
  it("2行に折り返して左端に来たメニューは左そろえ(左の外へはみ出さない)", () => {
    expect(menuAlignRight(24, 18.75, 1024)).toBe(false);
  });
  it("文字サイズ(rem)が大きいとメニューも広い", () => {
    expect(menuAlignRight(760, 16, 1024)).toBe(false);
    expect(menuAlignRight(760, 18.75, 1024)).toBe(true);
  });
});
