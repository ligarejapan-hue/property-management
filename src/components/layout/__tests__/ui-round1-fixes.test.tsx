/**
 * 画面すっきり化 第1回(発注者決定 2026-10-15): 困りごと5つ。
 *  ① 作った売却DMの発送を開き直す入口が無い → 発送一覧の画面+メニュー/DMメニュー/発送の画面から
 *  ② 右上の役職が英字 → 日本語の札
 *  ③ 添付のゴミ箱へどこからも行けない → 添付ファイル検索から
 *  ④ ヘルプに「Phase 2以降で実装予定」など古い説明 → 書き直し
 *  ⑤ パスワード変更が管理者のメニューにしか無い → 右上から全員
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: null, status: "loading" }) }));
import { headerRoleBadge } from "../header";
import { SIDEBAR_GROUPS, isNavItemActive, visibleSidebar } from "../sidebar-model";
import { CampaignListView, campaignProgressLabel, formatCampaignDate } from "@/components/sale-dm/campaign-list-view";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const byHref = (href: string) => SIDEBAR_GROUPS.flatMap((g) => g.items).find((i) => i.href === href);

describe("① 売却DMの発送一覧", () => {
  it("DM・LP関係のDMメニューの次に、事務担当から置く", () => {
    const dm = SIDEBAR_GROUPS.find((g) => g.key === "dm")?.items.map((i) => i.href) ?? [];
    expect(dm.slice(0, 2)).toEqual(["/dm", "/properties/sale-dm"]);
    expect(byHref("/properties/sale-dm")).toMatchObject({ label: "売却DMの発送一覧", minRole: "office_staff" });
    expect(visibleSidebar("field_staff").flatMap((g) => g.items).some((i) => i.href === "/properties/sale-dm")).toBe(false);
  });

  it("一覧と各発送の画面で光り、査定の申込や物件一覧とは同時に光らない", () => {
    expect(isNavItemActive("/properties/sale-dm", "/properties/sale-dm")).toBe(true);
    expect(isNavItemActive("/properties/sale-dm", "/properties/sale-dm/abc")).toBe(true);
    expect(isNavItemActive("/properties/sale-dm", "/properties/sale-dm/inquiries")).toBe(false);
    expect(isNavItemActive("/properties/sale-dm/inquiries", "/properties/sale-dm/inquiries")).toBe(true);
    expect(isNavItemActive("/properties", "/properties/sale-dm")).toBe(false);
    expect(isNavItemActive("/properties", "/properties/sale-dm/abc")).toBe(false);
  });

  it("DMメニューと発送の画面から一覧へ行ける", () => {
    expect(read("src/app/(dashboard)/dm/page.tsx")).toContain('href="/properties/sale-dm"');
    expect(read("src/app/(dashboard)/properties/sale-dm/[campaignId]/page.tsx")).toContain(
      '<BackLink href="/properties/sale-dm" to="売却DMの発送一覧" />',
    );
  });

  it("一覧の行は発送の画面へのリンク・件数と進み具合を出す", () => {
    const html = renderToStaticMarkup(
      <CampaignListView
        campaigns={[{ id: "c1", name: "10月 相続", status: "draft", createdAt: "2026-10-15T00:30:00Z", recipients: 5, sent: 2 }]}
      />,
    );
    expect(html).toContain('href="/properties/sale-dm/c1"');
    expect(html).toContain("10月 相続");
    expect(html).toContain("宛先 5件・送付済み 2件");
    expect(html).toContain("一部送付済み");
    expect(html).toContain("2026/10/15 09:30");
  });

  it("発送が無いときは作り方を案内する", () => {
    const html = renderToStaticMarkup(<CampaignListView campaigns={[]} />);
    expect(html).toContain("まだ発送を作っていません");
    expect(html).toContain('href="/properties"');
  });

  it("進み具合の言い方", () => {
    expect(campaignProgressLabel({ recipients: 0, sent: 0 })).toBe("宛先なし");
    expect(campaignProgressLabel({ recipients: 3, sent: 0 })).toBe("未送付");
    expect(campaignProgressLabel({ recipients: 3, sent: 3 })).toBe("すべて送付済み");
    expect(formatCampaignDate("not-a-date")).toBe("");
  });
});

describe("② 右上の役職を日本語で", () => {
  it("セッションの役割キーを日本語にする(大文字小文字は無視)", () => {
    expect(headerRoleBadge("admin")).toEqual({ label: "管理者", intent: "violet" });
    expect(headerRoleBadge("office_staff")).toEqual({ label: "事務担当", intent: "sky" });
    expect(headerRoleBadge("field_staff")).toEqual({ label: "現地担当", intent: "neutral" });
    expect(headerRoleBadge("ADMIN").label).toBe("管理者");
  });
  it("知らない値でも英字を出さない", () => {
    expect(headerRoleBadge("VIEWER").label).toBe("利用者");
    expect(headerRoleBadge("").label).toBe("利用者");
  });
});

describe("③ ゴミ箱への入口", () => {
  it("添付ファイル検索の見出しの右に置く", () => {
    const src = read("src/app/(dashboard)/admin/attachments/page.tsx");
    expect(src).toContain('href="/admin/attachments/trash"');
  });
});

describe("④ ヘルプの古い説明", () => {
  const HELP = read("src/app/(dashboard)/help/page.tsx");
  it("実装予定・旧い役割名が残っていない", () => {
    for (const gone of ["Phase 2", "実装予定", "マネージャー", "オペレーター", "閲覧者", "「エクスポート」"]) {
      expect(HELP, gone).not.toContain(gone);
    }
  });
  it("今の役割名と、画面名のリンクを書く", () => {
    expect(HELP).toContain("「管理者」「事務担当」「現地担当」");
    expect(HELP).toContain('<RoleLink href="/admin/change-password" minRole="field_staff">');
  });
});

describe("⑤ パスワード変更を全員に", () => {
  it("右上(全員に出るヘッダー)に入口を置く", () => {
    const src = read("src/components/layout/header.tsx");
    expect(src).toContain('href="/admin/change-password"');
    expect(src).toContain('aria-label="パスワード変更"');
  });
  it("画面に役割の制限が無い(API も本人の /api/me)", () => {
    const page = read("src/app/(dashboard)/admin/change-password/page.tsx");
    expect(page).toContain('"/api/me/change-password"');
    expect(page).not.toMatch(/canSee|role ===|minRole/);
  });
  it("API は管理者の権限を求めない・本人の分だけ・今のパスワードを照合する", () => {
    const api = read("src/app/api/me/change-password/route.ts");
    expect(api).not.toContain("user_management");
    expect(api).not.toContain("hasPermission");
    expect(api).toContain("await getApiSession()");
    expect(api).toContain("where: { id: session.id }");
    expect(api).toContain("compare(data.currentPassword, user.passwordHash)");
    expect(api).toContain('action: "password_change_self"');
  });
});
