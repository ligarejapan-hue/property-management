import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("@/lib/sale-dm-letter/config-store", () => ({
  loadSaleDmPublicPageConfig: vi.fn(),
}));
import { loadPublicLpPage } from "@/lib/sale-dm-letter/lp-public-loader";
import { loadSaleDmPublicPageConfig } from "@/lib/sale-dm-letter/config-store";

const cfg = loadSaleDmPublicPageConfig as unknown as ReturnType<typeof vi.fn>;
const CFG = {
  senderName: "株式会社リガーレ", senderContact: "TEL 03-1234-5678",
  trackingBaseUrl: "https://app.example.com", lpPublicEnabled: true, privacyText: null,
  google: null as { tagId: string; convLabel: string | null } | null,
};
const scenario = (over: Record<string, unknown> = {}) => ({
  id: "s1", name: "相続",
  lpHeadline: "相続した{{物件種別}}の売却", lpLead: "リード", lpBodyText: "■A\n本文", lpFaqJson: null,
  media: [{ slot: "hero", heading: null, figureKind: null, asset: { publicId: "a".repeat(32), width: 1600, height: 900, deletedAt: null } }],
  ...over,
});
const client = (row: unknown) => ({ dmScenario: { findFirst: vi.fn(async () => row) } });
const q = (m: Record<string, string>) => (k: string) => (k in m ? m[k] : null);

beforeEach(() => {
  vi.clearAllMocks();
  cfg.mockResolvedValue({ ...CFG });
});

describe("loadPublicLpPage(/lp/<公開名>)", () => {
  it("公開名が一致し・使う・文章あり なら public モードのページ(物件の差し込みなし・OGP・隠し欄)", async () => {
    const c = client(scenario());
    const r = await loadPublicLpPage(c as never, "souzoku", q({ utm_source: "google", gclid: "G1" }));
    expect(r.kind).toBe("page");
    if (r.kind !== "page") return;
    expect(r.scenarioId).toBe("s1");
    expect(r.scenarioName).toBe("相続");
    // 物件を差し込まない=一般形に落ちる
    expect(r.html).toContain("相続した不動産の売却");
    expect(r.html).toContain('name="robots" content="index,follow"');
    expect(r.html).toContain('property="og:url" content="https://app.example.com/lp/souzoku"');
    expect(r.html).toContain(`property="og:image" content="https://app.example.com/lp-assets/${"a".repeat(32)}"`);
    expect(r.html).toContain('<input type="hidden" name="utm_source" value="google" />');
    expect(r.html).toContain('<input type="hidden" name="gclid" value="G1" />');
    expect(r.html).toContain('action="/lp/souzoku/inquiry"');
    expect(r.html).not.toContain("プレビュー");
    expect(r.html).not.toContain("googletagmanager");
    expect(r.headers["Content-Security-Policy"]).not.toContain("googletagmanager");
    // 検索条件: 公開名・削除されていない・使う
    const arg = (c.dmScenario.findFirst.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0];
    expect(arg.where).toEqual({ publicSlug: "souzoku", deletedAt: null, active: true });
  });
  it("Google のタグが設定されていれば読み込みと CSP の緩和を public ページだけに入れる", async () => {
    cfg.mockResolvedValue({ ...CFG, google: { tagId: "AW-12345ABC", convLabel: "LbL-1234" } });
    const r = await loadPublicLpPage(client(scenario()) as never, "souzoku", q({}));
    expect(r.kind).toBe("page");
    if (r.kind !== "page") return;
    expect(r.html).toContain("googletagmanager.com/gtag/js?id=AW-12345ABC");
    expect(r.html).toContain("AW-12345ABC/LbL-1234");
    expect(r.headers["Content-Security-Policy"]).toContain("https://www.googletagmanager.com");
  });
  it("公開ゲートが閉じている・公開名が規則外・該当なし・文章なし はすべて none(DB を引く前に落とせるものは引かない)", async () => {
    cfg.mockResolvedValue({ ...CFG, lpPublicEnabled: false });
    const c1 = client(scenario());
    expect((await loadPublicLpPage(c1 as never, "souzoku", q({}))).kind).toBe("none");
    expect(c1.dmScenario.findFirst).not.toHaveBeenCalled();

    cfg.mockResolvedValue({ ...CFG });
    const c2 = client(scenario());
    expect((await loadPublicLpPage(c2 as never, "Sou zoku", q({}))).kind).toBe("none");
    expect(c2.dmScenario.findFirst).not.toHaveBeenCalled();

    expect((await loadPublicLpPage(client(null) as never, "souzoku", q({}))).kind).toBe("none");
    expect((await loadPublicLpPage(client(scenario({ lpBodyText: "   " })) as never, "souzoku", q({}))).kind).toBe("none");
    expect((await loadPublicLpPage(client(scenario({ lpHeadline: null })) as never, "souzoku", q({}))).kind).toBe("none");
  });
  it("追跡用URLが未設定なら og:url は相対パス・写真が無ければ og:image なし", async () => {
    cfg.mockResolvedValue({ ...CFG, trackingBaseUrl: undefined });
    const r = await loadPublicLpPage(client(scenario({ media: [] })) as never, "souzoku", q({}));
    expect(r.kind).toBe("page");
    if (r.kind !== "page") return;
    expect(r.html).toContain('property="og:url" content="/lp/souzoku"');
    expect(r.html).not.toContain('property="og:image"');
  });
});
