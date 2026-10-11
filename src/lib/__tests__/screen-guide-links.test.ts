// 説明文で別の画面を案内するところにはリンクを付ける(発注者 2026-10-12「○○からできる、と書いてあるならリンクを」)。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionProvider } from "next-auth/react";
import { SaleDmStepGuide } from "../../components/sale-dm/step-guide";
import { scenarioEditHref } from "../../components/sale-dm/scenario-edit-link";

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");

describe("説明文の中の画面へのリンク", () => {
  it("手順の案内: 宛先なし→物件一覧、送付済み→査定の申込", () => {
    const as = (role: string, el: ReturnType<typeof createElement>) =>
      renderToStaticMarkup(createElement(SessionProvider, { session: { user: { role }, expires: "2999-01-01T00:00:00.000Z" } } as never, el));
    const noRecipients = createElement(SaleDmStepGuide, { state: "no_recipients" });
    expect(as("office_staff", noRecipients)).toContain('href="/properties"');
    // 物件一覧を開けない現地担当には、同じ文字をただの文字で出す(押せそうで開けないリンクは出さない)。
    const field = as("field_staff", noRecipients);
    expect(field).toContain("物件一覧");
    expect(field).not.toContain('href="/properties"');
    expect(renderToStaticMarkup(createElement(SaleDmStepGuide, { state: "done" }))).toContain('href="/properties/sale-dm/inquiries"');
  });

  it("DMの種類の画面へのリンク先(種類が分かればその種類・無ければ一覧)", () => {
    expect(scenarioEditHref("abc")).toBe("/admin/dm-scenarios/abc");
    expect(scenarioEditHref(null)).toBe("/admin/dm-scenarios");
  });

  it("DMの種類の画面へのリンクは管理者にだけ出す(種類の画面は管理者専用)", () => {
    const src = read("components/sale-dm/scenario-edit-link.tsx");
    expect(src).toMatch(/if \(!isAdmin\) return null;/);
    for (const f of ["components/sale-dm/variant-manager.tsx", "components/sale-dm/lp-variant-manager.tsx"]) {
      expect(read(f)).toContain("<ScenarioEditLink scenarioId={letterFor.scenarioId} />");
    }
  });

  it.each([
    ["app/(dashboard)/admin/lp-assets/page.tsx", "/admin/dm-scenarios", "「DMの種類」"],
    ["app/(dashboard)/admin/dm-scenarios/page.tsx", "/properties", "物件一覧"],
    ["app/(dashboard)/admin/dm-scenarios/[id]/page.tsx", "/admin/dm-scenarios", "一覧"],
    ["app/(dashboard)/admin/mail-settings/page.tsx", "/admin/sale-dm-settings", "「売却DM設定」"],
    ["app/(dashboard)/dm/page.tsx", "/properties", "物件一覧"],
    ["app/(dashboard)/import/page.tsx", "/import/registry-pdf", "専用ページ"],
  ])("%s → %s", (file, href, label) => {
    const src = read(file);
    expect(src).toMatch(new RegExp(`<Link href="${href.replace(/[/]/g, "\\/")}"[^>]*>${label}</Link>`));
  });

  it("ヘルプ(全員が見る画面)のリンクは、開ける役割の人にだけリンクで出す", () => {
    const src = read("app/(dashboard)/help/page.tsx");
    expect(src).not.toContain("<Link");
    expect(src).toContain('<RoleLink href="/properties" minRole="office_staff">');
    expect(src).toContain('<RoleLink href="/import/paste" minRole="office_staff">「貼り付けて物件化」画面</RoleLink>');
    expect(src).toContain('<RoleLink href="/admin/users" minRole="admin">「ユーザー管理」画面</RoleLink>');
    expect(read("components/ui/role-link.tsx")).toContain("if (!USE_MOCK && !canSee(role, minRole)) return <>{children}</>;");
  });

  it("業者一覧: 検索で見つからないとき「しまった業者」の一覧へ切り替えられる", () => {
    expect(read("app/(dashboard)/agents/page.tsx")).toContain('onClick={() => { setQuery(""); setFilter("archived"); }}');
  });
});
