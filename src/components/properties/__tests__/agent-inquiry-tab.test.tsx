import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PropertyAgentInquiries } from "@/lib/api-client";
import { PropertyInquiryView, adSaveErrorMessage } from "../agent-inquiry-tab";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const data: PropertyAgentInquiries = {
  counts: { total: 4, guided: 2, preview: 1, materialRequest: 1, adPermission: 0 },
  adPermissions: { suumo: "ok", athome: "ng", flyer: "ask" },
  timeline: [
    { key: "viewing:v1", at: "2026-10-02T05:00:00.000Z", inquiryId: "q1", kind: "viewing", viewingType: "guided", agentName: "○○不動産", contactName: "田中", attendantName: "佐藤", resultNote: "前向き", canceled: false, unscheduled: false },
    { key: "viewing:v2", at: "2026-09-30T01:00:00.000Z", inquiryId: "q1", kind: "viewing", viewingType: "preview", agentName: "○○不動産", contactName: null, attendantName: null, resultNote: null, canceled: true, unscheduled: false },
    { key: "inquiry:q2", at: "2026-09-29T01:00:00.000Z", inquiryId: "q2", kind: "material_request", viewingType: null, agentName: "△△住宅", contactName: null, attendantName: null, resultNote: null, canceled: false, unscheduled: false },
  ],
};
const view = (p: Partial<Parameters<typeof PropertyInquiryView>[0]> = {}) =>
  renderToStaticMarkup(
    <PropertyInquiryView data={data} canEditAds savingMedium={null} message={null} onToggleAd={() => {}} onReload={() => {}} {...p} />,
  );

describe("物件画面の反響欄", () => {
  it("件数(反響・案内・下見・資料請求)を出す", () => {
    const out = view();
    expect(out).toContain("反響 4件");
    expect(out).toContain("案内 2");
    expect(out).toContain("下見 1");
    expect(out).toContain("資料請求 1");
  });
  it("編集できる人には広告の可否を6つのボタンで出す。今の値と、押すとどうなるかを読み上げで伝える", () => {
    const out = view();
    expect((out.match(/<button[^>]*data-ad-medium=/g) ?? []).length).toBe(6);
    expect(out).toContain('aria-label="SUUMO: 可。押すと 不可 に変わります"');
    expect(out).toContain('aria-label="自社HP: 未設定。押すと 可 に変わります"');
  });
  it("編集できない人にはボタンを出さない(値は見える)", () => {
    const out = view({ canEditAds: false });
    expect(out).not.toMatch(/<button[^>]*data-ad-medium=/);
    expect(out).toContain("SUUMO");
    expect(out).toContain("○");
  });
  it("★保存中は6つとも押せない(連打で古い値のまま2回目を送らない)", () => {
    const out = view({ savingMedium: "suumo" });
    expect((out.match(/<button[^>]*data-ad-medium=[^>]*disabled=""/g) ?? []).length).toBe(6);
  });
  it("時系列は新しい順のまま・年つきの日時・案内/下見・業者・立ち会い・結果", () => {
    const out = view();
    expect(out.indexOf("2026/10/2(金) 14:00")).toBeGreaterThan(-1);
    expect(out.indexOf("2026/10/2(金) 14:00")).toBeLessThan(out.indexOf("2026/9/29(火) 10:00"));
    expect(out).toContain("案内");
    expect(out).toContain("○○不動産");
    expect(out).toContain("立ち会い:佐藤");
    expect(out).toContain("前向き");
  });
  it("取り消した内見は薄くして「取り消し」と出す", () => {
    expect(view()).toMatch(/opacity-50[^>]*>[\s\S]*?取り消し/);
  });
  it("反響が無ければ「まだありません」", () => {
    expect(view({ data: { ...data, timeline: [], counts: { total: 0, guided: 0, preview: 0, materialRequest: 0, adPermission: 0 } } })).toContain("この物件への反響はまだありません");
  });
  it("知らせ(409 など)を出す", () => {
    expect(view({ message: "他の人が先に変えました" })).toContain("他の人が先に変えました");
  });
  it("受付の窓へは名前付きの窓で開く素のリンク(noopener を付けない)", () => {
    const out = view();
    expect(out).toMatch(/<a href="\/inquiry-desk" target="pm-inquiry-desk"/);
    expect(out).not.toMatch(/target="pm-inquiry-desk"[^>]*rel=/);
  });
});

describe("広告の可否の保存の失敗の文言", () => {
  const err = (code: string, status: number) => Object.assign(new Error("x"), { code, status });
  it("★409 は「他の人が先に変えた」と伝える(押した値になったとは言わない)", () => {
    expect(adSaveErrorMessage(err("VERSION_CONFLICT", 409))).toBe("他の人が先に変えました。今の表示が最新です。変えるときはもう一度押してください。");
  });
  it("403 は権限が無い", () => {
    expect(adSaveErrorMessage(err("FORBIDDEN", 403))).toBe("広告の可否を変える権限がありません。");
  });
  it("通信切れ・5xx は、変わったか分からないと伝える", () => {
    expect(adSaveErrorMessage(new Error("Failed to fetch"))).toBe("変更できたか分かりません(通信が切れました)。今の表示が最新です。");
    expect(adSaveErrorMessage(err("INTERNAL_ERROR", 502))).toBe("変更できたか分かりません(通信が切れました)。今の表示が最新です。");
  });
});

describe("物件画面への組み込み", () => {
  const page = read("src/app/(dashboard)/properties/[id]/page.tsx");
  it("タブ「反響」がネクストアクションの次にある", () => {
    expect(page).toMatch(/\{ key: "actions", label: "ネクストアクション" \},\n\s*\{ key: "inquiries", label: "反響" \},/);
  });
  it("物件ごとに作り直し(key)、物件の編集権限を渡す", () => {
    expect(page).toMatch(/<AgentInquiryTab key=\{property\.id\} propertyId=\{property\.id\} canWrite=\{canWriteProperty\} \/>/);
  });
  it("広告の可否の変更を権限なしで断られたら、その後はボタンを出さない", () => {
    const src = read("src/components/properties/agent-inquiry-tab.tsx");
    expect(src).toContain("canEditAds={canWrite && !writeDenied}");
    expect(src).toMatch(/apiErrorCode\(e\) === "FORBIDDEN"\) setWriteDenied\(true\)/);
  });
  it("反響タブは権限表を自分で読まない(3点セットの対象にしない)", () => {
    expect(read("src/components/properties/agent-inquiry-tab.tsx")).not.toContain("useScreenProtection");
  });
});
