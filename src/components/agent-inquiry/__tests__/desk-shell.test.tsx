import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: null, status: "loading" }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/inquiry-desk" }));
import { DeskShellView, activeDeskTab } from "../desk-shell";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const shell = (status: "loading" | "authenticated" | "unauthenticated", openCount: number | null = null) =>
  renderToStaticMarkup(
    <DeskShellView status={status} userName="佐藤" openCount={openCount} pathname="/inquiry-desk">
      <p>中身</p>
    </DeskShellView>,
  );

describe("受付の窓の枠(サイドバー無し)", () => {
  it("読み込み中", () => {
    expect(shell("loading")).toContain("読み込み中");
  });
  it("セッション切れはログインへ戻す", () => {
    const out = shell("unauthenticated");
    expect(out).toContain("セッションが切れました");
    expect(out).toContain("/login?callbackUrl=%2Finquiry-desk");
  });
  it("通常は見出し・利用者名・未対応件数・中身", () => {
    const ok = shell("authenticated", 3);
    expect(ok).toContain("反響の受付");
    expect(ok).toContain("佐藤");
    expect(ok).toContain("未対応 3件");
    expect(ok).toContain("<p>中身</p>");
  });
  it("窓の中に「反響の受付」「業者の名簿」のタブがあり、いまの画面のタブが選ばれている(2026-10-15)", () => {
    const ok = shell("authenticated");
    expect(ok).toContain('href="/inquiry-desk"');
    expect(ok).toContain('href="/agents"');
    expect(ok).toContain("業者の名簿");
    expect(ok).toMatch(/aria-current="page"[^>]*>反響の受付</);
    expect(activeDeskTab("/inquiry-desk")).toBe("/inquiry-desk");
    expect(activeDeskTab("/agents")).toBe("/agents");
    expect(activeDeskTab("/agents/abc")).toBe("/agents");
    // 似た名前の別の道は名簿のタブにしない。
    expect(activeDeskTab("/agentsx")).toBe("/inquiry-desk");
  });
  it("業者の名簿の画面は受付の窓の枠(サイドバー無し)の中で開く", () => {
    expect(existsSync(join(process.cwd(), "src/app/(desk)/agents/page.tsx"))).toBe(true);
    expect(existsSync(join(process.cwd(), "src/app/(desk)/agents/[id]/page.tsx"))).toBe(true);
    expect(existsSync(join(process.cwd(), "src/app/(dashboard)/agents"))).toBe(false);
  });
  it("レイアウトはログイン管理と無操作ログアウトを持ち、サイドバーを読み込まない", () => {
    const src = read("src/app/(desk)/layout.tsx");
    expect(src).toMatch(/<SessionProvider>/);
    expect(src).toMatch(/<IdleSessionGuard \/>/);
    expect(src).not.toMatch(/sidebar|DashboardLayout/i);
  });
});
