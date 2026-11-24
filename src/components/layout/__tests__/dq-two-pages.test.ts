// 「物件データ編集」は画面2つだけ(発注者指示 2026-11-24「わざわざ分けず可能な限りページ数を減らして」)。
// 経緯: 同じ日に「普段やる3つ」と「点検（ふだんは不要）」に分けた(案1)が、分けずに画面の数そのものを減らす方針に。
//   ・謄本の名義の確認 = 事務担当も開ける(所有者の直しは管理者だけ)ので、1つの画面にはまとめない
//   ・所有者の直し = もとの所有者補正候補。前の点検の4画面は2段目の「点検」タブへ移した
//   ・古いアドレスは所有者の直しの該当タブへ飛ばす(ブックマーク・資料のリンクを壊さない)
//   件数はメニューに出さない(重い集計が毎画面で走るため)。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SIDEBAR_GROUPS, visibleSidebar, isNavItemActive } from "../sidebar-model";
import { topNavEntries, OTHER_MENU_LABEL, isTopEntryActive } from "../top-nav-model";

const group = (key: string) => SIDEBAR_GROUPS.find((g) => g.key === key);
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const CORRECTION = read("src/app/(dashboard)/admin/owners/correction/page.tsx");

describe("物件データ編集=画面2つ", () => {
  it("謄本の名義の確認・所有者の直し の2つだけ", () => {
    expect(group("dq")?.items.map((i) => [i.label, i.href])).toEqual([
      ["謄本の名義の確認", "/properties/registry-owner-review"],
      ["所有者の直し", "/admin/owners/correction"],
    ]);
  });

  it("点検のグループは無い(分けない)", () => {
    expect(group("dq-check")).toBeUndefined();
    const labels = SIDEBAR_GROUPS.flatMap((g) => [g.label, ...g.items.map((i) => i.label)]);
    expect(labels.join("|")).not.toContain("点検（ふだんは不要）");
  });

  it("所有者の直しは管理者だけ・事務員には謄本の名義の確認だけが出る", () => {
    expect(group("dq")?.items.find((i) => i.label === "所有者の直し")?.minRole).toBe("admin");
    expect(visibleSidebar("office_staff").find((g) => g.key === "dq")?.items.map((i) => i.href)).toEqual([
      "/properties/registry-owner-review",
    ]);
  });

  it("一言説明で DM に効くこと・中身を言う", () => {
    const d = group("dq")?.description ?? "";
    for (const w of ["DM", "同じ人をまとめる", "住所を補う", "点検"]) expect(d, w).toContain(w);
  });

  it("上部ナビの「その他」でも、物件データ編集の次はシステム管理", () => {
    const other = topNavEntries(visibleSidebar("admin")).find((e) => e.key === "other");
    expect(other?.kind).toBe("menu");
    if (other?.kind !== "menu") return;
    expect(other.label).toBe(OTHER_MENU_LABEL);
    expect(other.sections.map((s) => s.label)).toEqual(["物件データ編集", "システム管理", "資料"]);
  });
});

describe("所有者の直し=もとの点検の4画面を2段目のタブに", () => {
  const CHECKS = [
    ["quality_audit", "氏名・連絡先チェック", "QualityAuditPanel", "/admin/owners/quality-audit", "quality-audit-panel"],
    ["text_hygiene", "テキスト衛生監査", "TextHygienePanel", "/admin/owners/text-hygiene", "text-hygiene-panel"],
    ["display_name", "表示名監査", "DisplayNameAuditPanel", "/admin/display-name-audit", "display-name-audit-panel"],
    ["postal_code", "郵便番号×住所チェック", "PostalCodeAuditPanel", "/admin/postal-code-audit", "postal-code-audit-panel"],
  ] as const;

  it("題名は「所有者の直し」", () => {
    expect(CORRECTION).toContain('<PageHeader title="所有者の直し" />');
  });

  it.each(CHECKS)("%s: タブ「%s」があり、URL の ?tab= から開け、中身は %s", (key, label, panel) => {
    expect(CORRECTION).toContain(`{ key: "${key}", label: "${label}" }`);
    expect(CORRECTION).toContain(`case "${key}":`);
    expect(CORRECTION).toContain(`{filterType === "${key}" && <${panel} />}`);
  });

  it("点検タブは自前で読み込む(上の候補一覧の読み込みを走らせない)", () => {
    const m = /const SELF_FETCH_TABS: FilterType\[\] = \[([\s\S]*?)\];/.exec(CORRECTION);
    for (const [key] of CHECKS) expect(m?.[1], key).toContain(`"${key}"`);
  });

  it("2段目の点検の段も同じ idBase(中身の tabpanel をどちらの段のタブからも指せる)", () => {
    expect(CORRECTION.match(/idBase="owner-correction"/g)?.length).toBe(2);
  });

  it.each(CHECKS)("%s: 古いアドレスは所有者の直しのタブへ飛ばす", (key, _label, _panel, oldHref) => {
    const src = read(`src/app/(dashboard)${oldHref}/page.tsx`);
    expect(src).toContain(`redirect("/admin/owners/correction?tab=${key}")`);
  });

  it.each(CHECKS)("%s: 中身の部品は自前の題名(PageHeader)・パンくずを持たない", (_key, _label, panel, _old, file) => {
    const src = read(`src/components/owners/checks/${file}.tsx`);
    expect(src).toContain(`export function ${panel}()`);
    expect(src).not.toContain("PageHeader");
    expect(src).not.toContain("<nav");
  });
});

describe("どのタブを開いていても「所有者の直し」が光る", () => {
  const C = "/admin/owners/correction";
  const active = (search: string) =>
    SIDEBAR_GROUPS.flatMap((g) => g.items)
      .filter((i) => isNavItemActive(i.href, C, "", search))
      .map((i) => i.href);

  it.each(["", "?tab=duplicate", "?tab=address_null", "?tab=quality_audit", "?tab=postal_code"])("%s", (search) => {
    expect(active(search)).toEqual([C]);
  });

  it("上部ナビの判定も search を受け取る", () => {
    const other = topNavEntries(visibleSidebar("admin")).find((e) => e.key === "other")!;
    expect(isTopEntryActive(other, C, "", "?tab=duplicate")).toBe(true);
  });

  it("外枠が URL の ? 以降を読んで、左メニューと上部ナビの両方へ渡す", () => {
    const layout = read("src/components/layout/dashboard-layout.tsx");
    expect(layout).toMatch(/useSearchParams/);
    expect(layout).toMatch(/<Suspense/);
    expect(layout).toMatch(/<Sidebar[^>]*currentSearch=\{search\}/);
    expect(layout).toMatch(/<TopNav[^>]*currentSearch=\{search\}/);
  });
});
