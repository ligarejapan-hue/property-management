import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("next/server", () => ({ NextResponse: Response }));
vi.mock("@/lib/prisma", () => ({
  default: { dmScenario: { findFirst: vi.fn() } },
}));
vi.mock("@/lib/sale-dm-letter/config-store", () => ({
  loadSaleDmPublicPageConfig: vi.fn(),
}));

import { GET } from "@/app/lp/[slug]/route";
import prisma from "@/lib/prisma";
import { loadSaleDmPublicPageConfig } from "@/lib/sale-dm-letter/config-store";
import { LP_SLUG_REDIRECTS, lpSlugRedirectTarget } from "@/lib/sale-dm-letter/lp-slug-redirects";

const findFirst = (prisma as unknown as { dmScenario: { findFirst: ReturnType<typeof vi.fn> } }).dmScenario.findFirst;
const loadCfg = loadSaleDmPublicPageConfig as unknown as ReturnType<typeof vi.fn>;

const CFG = {
  senderName: "株式会社リガーレ", senderContact: "TEL 03-1234-5678", trackingBaseUrl: "https://app.example.com",
  lpPublicEnabled: true, privacyText: null, google: null,
};
const SCENARIO = {
  id: "s1", name: "古い家", lpHeadline: "古い{{物件種別}}の売却", lpLead: null, lpBodyText: "■A\n本文", lpFaqJson: null,
  media: [],
};
const LIVE = new Set(["sumai", "baikyaku", "baikyaku-compare", "baikyaku-question", "baikyaku-form", "souzoku"]);

// ⚠レート制限はモジュール保持でテスト間リセットされない。IP をテストごとに変える。
let seq = 0;
function get(slug: string, query = "") {
  seq += 1;
  const req = new Request(`http://localhost:3000/lp/${slug}${query}`, {
    headers: { host: "app.ligarejapan.com", "x-forwarded-for": `10.9.${Math.floor(seq / 250)}.${seq % 250}` },
  });
  return GET(req as never, { params: Promise.resolve({ slug }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  loadCfg.mockResolvedValue({ ...CFG });
  findFirst.mockImplementation(async ({ where }: { where: { publicSlug: string } }) => (LIVE.has(where.publicSlug) ? { ...SCENARIO } : null));
});

describe("旧公開名の転送(固定の対応表)", () => {
  it("対応表は furuiie → sumai だけ", () => {
    expect(LP_SLUG_REDIRECTS).toEqual({ furuiie: "sumai" });
    expect(lpSlugRedirectTarget("furuiie")).toBe("sumai");
    expect(lpSlugRedirectTarget("FURUIIE")).toBe("sumai");
    for (const s of ["sumai", "baikyaku", "baikyaku-question", "constructor", "__proto__", "toString", ""]) {
      expect(lpSlugRedirectTarget(s)).toBeNull();
    }
  });
});

describe("GET /lp/furuiie → /lp/sumai(308)", () => {
  it("308 で /lp/sumai へ・DB は読まない", async () => {
    const res = await get("furuiie");
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/lp/sumai");
    expect(await res.text()).toBe("");
    expect(findFirst).not.toHaveBeenCalled();
    expect(loadCfg).not.toHaveBeenCalled();
  });
  it("クエリ(utm・gclid など)はそのまま引き継ぐ", async () => {
    const q = "?utm_source=google&utm_medium=cpc&utm_campaign=aki%20ya&gclid=G1&fbclid=x";
    const res = await get("furuiie", q);
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`/lp/sumai${q}`);
  });
  it("大文字の旧公開名も転送する(公開名は小文字に揃える決まりと同じ)", async () => {
    const res = await get("Furuiie", "?gclid=G2");
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/lp/sumai?gclid=G2");
  });
});

describe("ほかの公開名は今までどおり表示", () => {
  it.each(["sumai", "baikyaku", "baikyaku-compare", "baikyaku-question", "baikyaku-form", "souzoku"])("%s は 200", async (slug) => {
    const res = await get(slug, "?utm_source=google");
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(findFirst.mock.calls[0][0].where).toEqual({ publicSlug: slug, deletedAt: null, active: true });
  });
  it("対応表にない公開名は今までどおり 404", async () => {
    expect((await get("akiya")).status).toBe(404);
  });
});
