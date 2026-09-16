import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (p: string) => readFileSync(path.resolve(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

describe("申込の社内画面", () => {
  const panel = read("src/components/sale-dm/inquiry-list.tsx");
  it("申込者の個人情報を画面保護(S1b)の対象にする", () => {
    expect(panel).toContain("data-pii-protected");
    expect(panel).toContain('data-pii-surface="owner"');
  });
  it("状態は3つだけ・日本語ラベル", () => {
    for (const s of ['"open"', '"in_progress"', '"done"', "未対応", "対応中", "対応済み"]) expect(panel).toContain(s);
  });
  it("権限で伏せたときの案内がある", () => {
    expect(panel).toContain("contactHidden");
    expect(panel).toMatch(/表示する権限がありません/);
  });
  it("メールは電話とは別レベルで伏せられ、伏せたときの案内がある(@codex P1)", () => {
    expect(panel).toContain("emailHidden");
    expect(panel).toMatch(/表示する権限がありません/);
  });
  it("走査規約: bg-blue-600・手書きモーダルを使わない", () => {
    expect(panel).not.toContain("bg-blue-600");
    expect(panel).not.toContain("fixed inset-0");
  });
  it("読み込み失敗時はスピナーを止めて再読み込みできる", () => {
    expect(panel).toContain("items === null && !error");
    expect(panel).toContain("再読み込み");
  });
  it("キャンペーン画面に配置され、宛先一覧に申込バッジがある", () => {
    expect(read("src/app/(dashboard)/properties/sale-dm/[campaignId]/page.tsx")).toContain("<SaleDmInquiryList");
    expect(read("src/components/sale-dm/recipient-list.tsx")).toMatch(/formInquiryCount/);
  });
  it("キャンペーン API は宛先の申込計数を返す(token は返さない)", () => {
    const route = read("src/app/api/properties/sale-dm/campaigns/[id]/route.ts");
    expect(route).toContain("formInquiryCount: r.formInquiryCount");
    expect(route).toContain("formInquiryFirstAt: r.formInquiryFirstAt");
    expect(route).not.toMatch(/trackingToken:\s*r\./);
  });
  it("一覧は状態で絞らない1本のカーソルでたどり、画面で「対応が必要」「対応済み」に振り分ける(@codex P2)", () => {
    const api = read("src/lib/api-client.ts");
    expect(panel).toContain("さらに読み込む");
    expect(panel).toContain("対応が必要");
    expect(panel).toContain("対応済みを表示");
    expect(panel).toContain("対応済みを隠す");
    expect(panel).toContain("counts.active");
    expect(panel).toContain("まだ読み込んでいない古い申込にも");
    expect(panel).toContain("nextCursor");
    expect(panel).not.toContain("segment");
    expect(panel).not.toContain("nextOffset");
    expect(panel).not.toContain("?offset=");
    const fetcher = api.slice(api.indexOf("export async function fetchSaleDmInquiries"), api.indexOf("export async function updateSaleDmInquiryStatus"));
    expect(api).not.toContain("segment=");
    expect(fetcher).toContain("cursor=");
    expect(fetcher).toContain("counts");
    expect(fetcher).not.toContain("nextOffset");
    expect(fetcher).not.toContain("?offset=");
  });
});
