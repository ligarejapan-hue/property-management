import { describe, it, expect, vi, afterEach } from "vitest";
vi.mock("@/lib/sale-dm-letter/config-store", () => ({
  loadSaleDmPublicPageConfig: vi.fn(async () => ({
    senderName: "株式会社リガーレ", senderContact: "TEL 03-1234-5678",
    trackingBaseUrl: "https://lp.example.com", lpPublicEnabled: true,
  })),
}));
import { loadLpPageData } from "../sale-dm-letter/lp-page-loader";
import { loadSaleDmPublicPageConfig } from "../sale-dm-letter/config-store";

const draft = (over: Record<string, unknown> = {}) => ({
  id: "r1", propertyId: "p1", status: "sent", trackingToken: "tok",
  lpVariant: { headline: "ご所有の{{物件種別}}", lead: null, bodyText: "■A\nx", faqJson: null, media: [] },
  property: { address: "東京都世田谷区経堂1-2-3", propertyType: "house" },
  ...over,
});
const client = (row: unknown) => ({ dmRecipientDraft: { findUnique: vi.fn(async () => row) } });
// zero-arg mock の呼び出し引数を型付きで取り出す(実装のシグネチャを変えず、検査側だけキャストする)。
const findUniqueArg = (c: ReturnType<typeof client>): { select: unknown; where: unknown } =>
  (c.dmRecipientDraft.findUnique.mock.calls[0] as unknown as [{ select: unknown; where: unknown }])[0];

describe("loadLpPageData", () => {
  it("LP型に文章があればページ HTML を返す(差し込み済み・status 付き)", async () => {
    const c = client(draft());
    const r = await loadLpPageData(c as never, "tok");
    expect(r.kind).toBe("page");
    if (r.kind !== "page") return;
    expect(r.status).toBe("sent");
    expect(r.html).toContain("ご所有の戸建");
    expect(r.html).not.toContain("プレビュー");
    // ページを返せたときの閲覧記録(recordLpPageView)へ渡す識別子(@codex R10)。PII ではない。
    expect(r.draftId).toBe("r1");
    expect(r.propertyId).toBe("p1");
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
  it("見出し・本文が空白のみでも none(空文と同じ扱い)", async () => {
    expect((await loadLpPageData(client(draft({ lpVariant: { headline: "   ", lead: null, bodyText: "■A\nx", faqJson: null, media: [] } })) as never, "tok")).kind).toBe("none");
    expect((await loadLpPageData(client(draft({ lpVariant: { headline: "見出し", lead: null, bodyText: "   \n  ", faqJson: null, media: [] } })) as never, "tok")).kind).toBe("none");
  });
  it("select に氏名・宛先住所・所有者を含めない(構造で PII を渡さない・find引数全体で確認)", async () => {
    const c = client(draft());
    await loadLpPageData(c as never, "tok");
    const arg = JSON.stringify(findUniqueArg(c));
    expect(arg).not.toMatch(/recipientName|recipientAddress|recipientZip|owner|draftOwners/);
    expect(arg).toMatch(/"address":true/);
  });
  it("公開・未認証経路ゆえ APIキーを読む全設定リーダーを使わない(loadSaleDmPublicPageConfig を呼ぶ)", async () => {
    const c = client(draft());
    await loadLpPageData(c as never, "tok");
    expect(loadSaleDmPublicPageConfig).toHaveBeenCalled();
  });

  it("ロールアウトゲート: lpPublicEnabled=false なら送付済み・LP型ありの draft でも none(DB読み取りも省略)", async () => {
    vi.mocked(loadSaleDmPublicPageConfig).mockResolvedValueOnce({
      senderName: "株式会社リガーレ", senderContact: "TEL 03-1234-5678",
      trackingBaseUrl: "https://lp.example.com", lpPublicEnabled: false,
    });
    const c = client(draft());
    const r = await loadLpPageData(c as never, "tok");
    expect(r.kind).toBe("none");
    expect(c.dmRecipientDraft.findUnique).not.toHaveBeenCalled();
  });

  describe("R1: 配信停止URLの有無は NEXTAUTH_SECRET の有無に依存し、他のテストの実行順に依存しない", () => {
    const ENV = process.env;
    afterEach(() => { process.env = ENV; });

    it("NEXTAUTH_SECRET 設定時: live は /u/ の配信停止リンクを含み、trackingBaseUrl を base に使う", async () => {
      process.env = { ...ENV, NEXTAUTH_SECRET: "test-secret-for-unsubscribe-key" };
      const r = await loadLpPageData(client(draft({ status: "sent" })) as never, "tok");
      expect(r.kind).toBe("page");
      if (r.kind !== "page") return;
      expect(r.html).toContain("/u/");
      expect(r.html).toContain("https://lp.example.com/u/");
    });
    it("NEXTAUTH_SECRET 設定時: preview(送付前)は配信停止リンクを含まない", async () => {
      process.env = { ...ENV, NEXTAUTH_SECRET: "test-secret-for-unsubscribe-key" };
      const r = await loadLpPageData(client(draft({ status: "confirmed" })) as never, "tok");
      expect(r.kind).toBe("page");
      if (r.kind !== "page") return;
      expect(r.html).not.toContain("/u/");
    });
    it("NEXTAUTH_SECRET 未設定時: live でもページ自体は出る(kind:page)が配信停止リンクは無い(入口を壊さない)", async () => {
      process.env = { ...ENV };
      delete process.env.NEXTAUTH_SECRET;
      const r = await loadLpPageData(client(draft({ status: "sent" })) as never, "tok");
      expect(r.kind).toBe("page");
      if (r.kind !== "page") return;
      expect(r.html).not.toContain("/u/");
    });
  });
});
