/**
 * 画面すっきり化 第4回 E(発注者決定 2026-10-16): DMメニューに「準備チェック」と「最近の発送」。
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DmReadinessView } from "../dm-readiness-view";
import { buildDmReadiness } from "@/lib/sale-dm-letter/dm-readiness";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const PAGE = "src/app/(dashboard)/dm/page.tsx";

const notReady = buildDmReadiness({
  settingsMissing: ["差出人名"],
  scenarios: [
    { id: "a", name: "相続", letterReady: true, lpReady: true },
    { id: "b", name: "空き家", letterReady: true, lpReady: false },
  ],
});

describe("準備チェックの見た目", () => {
  it("✓/!/× と足りない項目を出す", () => {
    const html = renderToStaticMarkup(<DmReadinessView readiness={notReady} isAdmin />);
    expect(html).toContain("売却DMを作る前に、×の項目を直してください。");
    expect(html).toContain("未設定: 差出人名");
    expect(html).toContain("DMの種類「空き家」");
    expect((html.match(/data-testid="dm-readiness-item"/g) ?? []).length).toBe(3);
    expect(html).toContain('aria-label="このままでは作れません"');
    expect(html).toContain('aria-label="足りないものがあります"');
  });

  it("管理者には直す画面へのリンク、そうでない人には押せるリンクを出さない", () => {
    const admin = renderToStaticMarkup(<DmReadinessView readiness={notReady} isAdmin />);
    expect(admin).toContain('href="/admin/sale-dm-settings"');
    expect(admin).toContain('href="/admin/dm-scenarios"');
    const staff = renderToStaticMarkup(<DmReadinessView readiness={notReady} isAdmin={false} />);
    expect(staff).not.toContain('href="/admin/');
    expect(staff).toContain("管理者にご依頼ください");
  });

  it("そろっていれば直すリンクは出ない", () => {
    const ok = buildDmReadiness({ settingsMissing: [], scenarios: [{ id: "a", name: "相続", letterReady: true, lpReady: true }] });
    const html = renderToStaticMarkup(<DmReadinessView readiness={ok} isAdmin />);
    expect(html).toContain("売却DMを作る準備はそろっています。");
    expect(html).not.toContain("直す");
  });
});

describe("DMメニューの画面", () => {
  const src = read(PAGE);
  it("準備チェック・最近の発送を手順の案内より上に出す", () => {
    const r = src.indexOf('data-testid="dm-readiness"');
    const c = src.indexOf('data-testid="dm-recent-campaigns"');
    const steps = src.indexOf("送る流れ</h2>");
    expect(r).toBeGreaterThan(-1);
    expect(c).toBeGreaterThan(r);
    expect(steps).toBeGreaterThan(c);
  });
  it("口は準備チェックと発送一覧の2つ・最近の発送は5件", () => {
    expect(src).toContain('useSaleDmGet<DmReadiness>("/api/properties/sale-dm/readiness")');
    expect(src).toContain('useSaleDmGet<CampaignListPage>("/api/properties/sale-dm/campaigns")');
    expect(src).toContain("const RECENT_CAMPAIGNS = 5;");
    expect(src).toContain(".slice(0, RECENT_CAMPAIGNS)");
    expect(src).toContain('href="/properties/sale-dm"');
  });
  it("売却DMを使えない人(403)には欄ごと出さない", () => {
    expect(src).toMatch(/if \(res\.status === 403\) \{\s*setLoad\(\{ state: "hidden" \}\);/);
    expect(src).toContain('readiness.state !== "hidden" &&');
    expect(src).toContain('recent.state !== "hidden" &&');
  });
  it("直すリンクは管理者だけ", () => {
    expect(src).toContain('isAdmin={canSee(userRole, "admin")}');
  });
});

describe("アプリのURLの2つの欄(まとめずに説明と行き来のリンク)", () => {
  it("売却DM設定の追跡用URLは公開ページの住所と書き、メール送信設定へリンク", () => {
    const src = read("src/app/(dashboard)/admin/sale-dm-settings/page.tsx");
    expect(src).toContain('label="追跡用URL(お客さまがQRで開く公開ページのアドレス)"');
    expect(src).not.toContain("このシステムの絶対URL");
    expect(src).toMatch(/data-testid="sale-dm-tracking-url-note"[\s\S]*?href="\/admin\/mail-settings"/);
  });
  it("メール送信設定のアプリのURLは社内の住所と書き、売却DM設定へリンク", () => {
    const src = read("src/app/(dashboard)/admin/mail-settings/page.tsx");
    expect(src).toMatch(/data-testid="mail-app-url-note"[\s\S]*?href="\/admin\/sale-dm-settings"/);
  });
});
