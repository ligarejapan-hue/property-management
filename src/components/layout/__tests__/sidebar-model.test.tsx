import { describe, it, expect } from "vitest";
import { visibleSidebar } from "../sidebar-model";

function sidebarLabels(role: string): string[] {
  return visibleSidebar(role).flatMap((g) => g.items.map((i) => i.label));
}
function groupLabels(role: string): (string | null)[] {
  return visibleSidebar(role).map((g) => g.label);
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
    expect(labels).not.toContain("会社情報（販売図面の差出人）");
    expect(labels).not.toContain("売却DM設定");
    expect(labels).not.toContain("ユーザー管理");
    expect(labels).not.toContain("所有者補正候補");
    // メニュー再編(2026-08-24): 事務担当も DMメニューと取り込み4種は使う。
    expect(labels).toContain("DMメニュー");
    expect(labels).toContain("所有者CSV取込");
    expect(labels).toContain("物件データエラー確認");
    // ⚠添付ファイル検索は「物件」へ移したが**権限は据え置き**=事務には出ない。
    expect(labels).not.toContain("添付ファイル検索");
  });

  it("管理者: 全部見える(設定・物件データ編集・システム管理)", () => {
    const labels = sidebarLabels("admin");
    expect(labels).toContain("会社情報（販売図面の差出人）");
    expect(labels).toContain("売却DM設定");
    expect(labels).toContain("所有者補正候補");
    expect(labels).toContain("ユーザー管理");
    expect(labels).toContain("添付ファイル検索");
    expect(labels).toContain("送付記録の訂正");
    // ⚠謄本取得の資格情報は画面ごと廃止(発注者決定 2026-08-24)。
    expect(labels).not.toContain("謄本取得の資格情報");
  });
});
