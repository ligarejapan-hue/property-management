import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/sale-dm-letter/config-store", () => ({ loadSaleDmConfig: vi.fn(async () => ({ senderName: "株式会社リガーレ", senderContact: "TEL 03-1234-5678", trackingBaseUrl: "https://lp.example.com", lpUrl: "https://x.example/lp", provider: "none", model: "", anthropicApiKey: undefined, openaiApiKey: undefined, useMock: false })) }));
import { loadLpPageData } from "../sale-dm-letter/lp-page-loader";

const draft = (over: Record<string, unknown> = {}) => ({
  status: "sent", trackingToken: "tok",
  lpVariant: { headline: "ご所有の{{物件種別}}", lead: null, bodyText: "■A\nx", faqJson: null, media: [] },
  property: { address: "東京都世田谷区経堂1-2-3", propertyType: "house" },
  ...over,
});
const client = (row: unknown) => ({ dmRecipientDraft: { findUnique: vi.fn(async (_args: { select: unknown }) => row) } });

describe("loadLpPageData", () => {
  it("LP型に文章があればページ HTML を返す(差し込み済み・status 付き)", async () => {
    const c = client(draft());
    const r = await loadLpPageData(c as never, "tok");
    expect(r.kind).toBe("page");
    if (r.kind !== "page") return;
    expect(r.status).toBe("sent");
    expect(r.html).toContain("ご所有の戸建");
    expect(r.html).not.toContain("プレビュー");
  });
  it("送付前なら preview モード(帯あり・script なし)", async () => {
    const r = await loadLpPageData(client(draft({ status: "confirmed" })) as never, "tok");
    expect(r.kind === "page" && r.html.includes("プレビュー") && !r.html.includes("<script")).toBe(true);
  });
  it("未知 token・LP型なし・文章未保存は none", async () => {
    expect((await loadLpPageData(client(null) as never, "tok")).kind).toBe("none");
    expect((await loadLpPageData(client(draft({ lpVariant: null })) as never, "tok")).kind).toBe("none");
    expect((await loadLpPageData(client(draft({ lpVariant: { headline: null, lead: null, bodyText: null, faqJson: null, media: [] } })) as never, "tok")).kind).toBe("none");
  });
  it("select に氏名・宛先住所・所有者を含めない(構造で PII を渡さない)", async () => {
    const c = client(draft());
    await loadLpPageData(c as never, "tok");
    const select = JSON.stringify(c.dmRecipientDraft.findUnique.mock.calls[0][0].select);
    expect(select).not.toMatch(/recipientName|recipientAddress|recipientZip|owner|draftOwners/);
    expect(select).toMatch(/"address":true/);
  });
});
