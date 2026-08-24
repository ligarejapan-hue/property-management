import { describe, it, expect } from "vitest";
import { visibleHomeCards } from "../home-model";
import { SIDEBAR_GROUPS } from "@/components/layout/sidebar-model";

function homeLabels(role: string): string[] {
  return visibleHomeCards(role).map((c) => c.label);
}
function homeCards(role: string) {
  return visibleHomeCards(role);
}

describe("visibleHomeCards", () => {
  it("現場: 現地調査マップ(大)が先頭、物件/販売図面カードは無い", () => {
    const cards = visibleHomeCards("field_staff");
    expect(cards[0].label).toBe("現地調査マップ");
    expect(cards[0].big).toBe(true);
    expect(homeLabels("field_staff")).not.toContain("物件");
    expect(homeLabels("field_staff")).not.toContain("販売図面");
  });
  it("事務: 物件/現地調査/物件データ取り込み/販売図面/DMメニュー/資料。管理者専用は無い", () => {
    const labels = homeLabels("office_staff");
    expect(labels).toContain("物件");
    expect(labels).toContain("販売図面");
    expect(labels).toContain("物件データ取り込み");
    // メニュー再編(2026-08-24): DM の入口は事務担当にも出す(設定は管理者のまま)。
    expect(labels).toContain("DMメニュー");
    expect(labels).not.toContain("システム管理");
    expect(labels).not.toContain("物件データ編集");
  });
  it("管理者: 物件データ編集・システム管理カードもある", () => {
    const labels = homeLabels("admin");
    expect(labels).toContain("DMメニュー");
    expect(labels).toContain("物件データ編集");
    expect(labels).toContain("システム管理");
  });

  it("⚠ホームとサイドバーで、同じ画面に違う名前を出さない(内部レビューP2)", () => {
    // ログイン後に最初に見るのはホーム。ここが旧名のままだと、同じ画面が
    // サイドバーと別名で並び、「名前で迷わせない」という再編の目的を裏切る。
    const sidebarLabelByHref = new Map<string, string>();
    for (const g of SIDEBAR_GROUPS) {
      for (const i of g.items) sidebarLabelByHref.set(i.href, i.label);
      // グループ名も突き合わせの対象にする(ホームのカードは「まとまり」への入口)。
    }
    const sidebarGroupLabels = new Set(
      SIDEBAR_GROUPS.map((g) => g.label).filter((l): l is string => !!l),
    );
    for (const c of homeCards("admin")) {
      // ホームのカードは「その画面そのもの」か「そのまとまりの入口」のどちらか。
      // どちらの呼び名とも違う**第三の名前**を作らないことを守る。
      const sameAsItem = sidebarLabelByHref.get(c.href) === c.label;
      const sameAsGroup = sidebarGroupLabels.has(c.label);
      expect(
        sameAsItem || sameAsGroup,
        `${c.href} の「${c.label}」がサイドバーのどの呼び名とも一致しない`,
      ).toBe(true);
    }
  });

  it("旧い名前がホームに残っていない", () => {
    const labels = homeLabels("admin");
    for (const gone of ["取込・登記", "データ品質", "売却DM"]) {
      expect(labels, gone).not.toContain(gone);
    }
  });
});
