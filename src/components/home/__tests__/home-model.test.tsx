import { describe, it, expect } from "vitest";
import { visibleHomeCards } from "../home-model";

function homeLabels(role: string): string[] {
  return visibleHomeCards(role).map((c) => c.label);
}

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
