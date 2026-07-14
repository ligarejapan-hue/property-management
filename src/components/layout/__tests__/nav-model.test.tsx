import { describe, it, expect } from "vitest";
import { visibleSidebar, visibleHomeCards } from "../nav-model";

function sidebarLabels(role: string): string[] {
  return visibleSidebar(role).flatMap((g) => g.items.map((i) => i.label));
}
function groupLabels(role: string): (string | null)[] {
  return visibleSidebar(role).map((g) => g.label);
}
function homeLabels(role: string): string[] {
  return visibleHomeCards(role).map((c) => c.label);
}

describe("visibleSidebar", () => {
  it("現場: 現地調査＋資料＋ホームだけ。物件/取込/販売図面/管理は出ない", () => {
    const labels = sidebarLabels("field_staff");
    expect(labels).toContain("ホーム");
    expect(labels).toContain("現地調査マップ");
    expect(labels).toContain("使い方ガイド");
    expect(labels).not.toContain("物件一覧");
    expect(labels).not.toContain("受付帳CSV取込");
    expect(labels).not.toContain("販売図面を作成");
    expect(labels).not.toContain("ユーザー管理");
    expect(groupLabels("field_staff")).not.toContain("物件");
    expect(groupLabels("field_staff")).not.toContain("システム管理");
  });

  it("事務: 物件〜販売図面(作成)＋資料。管理者専用は出ない", () => {
    const labels = sidebarLabels("office_staff");
    expect(labels).toContain("物件一覧");
    expect(labels).toContain("受付帳CSV取込");
    expect(labels).toContain("販売図面を作成");
    expect(labels).not.toContain("会社情報");
    expect(labels).not.toContain("売却DM設定");
    expect(labels).not.toContain("ユーザー管理");
    expect(labels).not.toContain("所有者補正候補");
  });

  it("管理者: 全部見える(設定・データ品質・システム管理)", () => {
    const labels = sidebarLabels("admin");
    expect(labels).toContain("会社情報");
    expect(labels).toContain("売却DM設定");
    expect(labels).toContain("所有者補正候補");
    expect(labels).toContain("ユーザー管理");
    expect(labels).toContain("謄本取得の資格情報");
  });
});

describe("visibleHomeCards", () => {
  it("現場: 現地調査マップ(大)が先頭、物件/販売図面カードは無い", () => {
    const cards = visibleHomeCards("field_staff");
    expect(cards[0].label).toBe("現地調査マップ");
    expect(cards[0].big).toBe(true);
    expect(homeLabels("field_staff")).not.toContain("物件");
    expect(homeLabels("field_staff")).not.toContain("販売図面");
  });
  it("事務: 物件/現地調査/取込・登記/販売図面/資料。売却DM等は無い", () => {
    const labels = homeLabels("office_staff");
    expect(labels).toContain("物件");
    expect(labels).toContain("販売図面");
    expect(labels).not.toContain("売却DM");
    expect(labels).not.toContain("システム管理");
  });
  it("管理者: 売却DM・データ品質・システム管理カードもある", () => {
    const labels = homeLabels("admin");
    expect(labels).toContain("売却DM");
    expect(labels).toContain("データ品質");
    expect(labels).toContain("システム管理");
  });
});
