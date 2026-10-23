import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SIDEBAR_GROUPS } from "@/components/layout/sidebar-model";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const PAGE = "src/app/(dashboard)/admin/deal-settings/page.tsx";

describe("取引の設定の画面", () => {
  it("システム管理の会社情報の次・管理者だけ", () => {
    const admin = SIDEBAR_GROUPS.find((g) => g.key === "admin")!;
    const hrefs = admin.items.map((i) => i.href);
    expect(hrefs.indexOf("/admin/deal-settings")).toBe(hrefs.indexOf("/admin/company-settings") + 1);
    expect(admin.items.find((i) => i.href === "/admin/deal-settings")).toMatchObject({ label: "取引の設定", minRole: "admin" });
  });
  it("題名・代表者・口座・物件種別・税率の表(見るだけ)", () => {
    const src = read(PAGE);
    expect(src).toContain('title="取引の設定"');
    for (const s of ["代表者", "振込先口座", "物件種別", "税率・税額の表"]) expect(src).toContain(s);
    expect(src).toContain("会社情報（販売図面の差出人）");
    expect(src).not.toMatch(/<button[\s>]/);
  });
  it("基本の4種別は消せない(消すボタンを出さない)", () => {
    expect(read(PAGE)).toMatch(/\(BASE_PROPERTY_KINDS as readonly string\[\]\)\.includes\(k\.key\)/);
  });
  it("税率の表を直せる: 直す・期間を足す・消す(確認つき)", () => {
    const src = read(PAGE);
    expect(src).toContain("<RateTableEditor");
    expect(src).toContain("期間を足す");
    expect(src).toContain("<ConfirmDialog");
    expect(src).not.toContain("表を直す画面は、計算を入れるときに足します");
    const ed = read("src/components/deals/rate-table-editor.tsx");
    for (const s of ["適用開始", "適用終了", "上限なし", "VERSION_CONFLICT", "PERIOD_OVERLAP"]) expect(ed, s).toContain(s);
  });
  it("基本の4種別は元の種別も変えられない(M1)", () => {
    expect(read(PAGE)).toMatch(/label="元の種別"[^>]*disabled=\{isBase\}/);
  });
});

describe("@codex: 税率の表の編集欄は、選んだ表が変わったら作り直す", () => {
  it("RateTableEditor に選んだ表ごとの key", () => {
    expect(read(PAGE)).toMatch(/<RateTableEditor\s+key=\{/);
  });
});
