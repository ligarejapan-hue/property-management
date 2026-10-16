import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", () => {
  class MockNextResponse extends Response { static json = (b: unknown, init?: ResponseInit) => Response.json(b, init); }
  return { NextResponse: MockNextResponse };
});
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error { status: number; code: string; constructor(s: number, m: string, c = "ERROR") { super(m); this.status = s; this.code = c; } }
  return {
    ApiError: MockApiError,
    handleApiError: vi.fn((e: unknown) => e instanceof MockApiError ? Response.json({ error: { message: e.message, code: e.code } }, { status: e.status }) : Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 })),
  };
});
const { requireSaleDmAccess, loadSaleDmConfig, findMany } = vi.hoisted(() => ({
  requireSaleDmAccess: vi.fn(),
  loadSaleDmConfig: vi.fn(),
  findMany: vi.fn(),
}));
vi.mock("@/lib/sale-dm-letter/route-guard", () => ({ requireSaleDmAccess }));
vi.mock("@/lib/sale-dm-letter/config-store", () => ({ loadSaleDmConfig }));
vi.mock("@/lib/sale-dm-letter/scenario-guard", () => ({
  SCENARIO_OPTION_SELECT: { id: true, name: true, sortOrder: true, autoKey: true },
}));
vi.mock("@/lib/prisma", () => ({ default: { dmScenario: { findMany } } }));
vi.mock("@/generated/prisma", () => ({ Prisma: {} }));

import { ApiError } from "@/lib/api-helpers";
import { GET } from "../../app/api/properties/sale-dm/readiness/route";

const letter = { letterBodyTemplate: "本文", designTemplate: "formal", tone: "t", length: "l", appeal: "a", strength: "s" };
const lp = { lpBodyText: "本文", lpHeadline: "見出し", lpTone: "t", lpLength: "l", lpAppeal: "a", lpStrength: "s" };
const noLp = { lpBodyText: null, lpHeadline: null, lpTone: null, lpLength: null, lpAppeal: null, lpStrength: null };

beforeEach(() => {
  vi.clearAllMocks();
  requireSaleDmAccess.mockResolvedValue({ session: { id: "u1" } });
  loadSaleDmConfig.mockResolvedValue({
    trackingBaseUrl: "https://lp.example.com",
    lpUrl: "https://lp.example.com/top",
    senderName: "差出人",
    senderContact: "03-0000-0000",
  });
});

describe("GET /api/properties/sale-dm/readiness(DMメニューの準備チェック)", () => {
  it("売却DMを使えない人は 403(門は発送一覧と同じ)", async () => {
    requireSaleDmAccess.mockRejectedValue(new (ApiError as unknown as new (s: number, m: string, c: string) => Error)(403, "権限がありません", "FORBIDDEN"));
    const res = await GET();
    expect(res.status).toBe(403);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("使える種類だけを読み、手紙・LPの登録を判定する(文面・設定の値は返さない)", async () => {
    findMany.mockResolvedValue([
      { id: "a", name: "相続", sortOrder: 1, autoKey: "inheritance", ...letter, ...lp },
      { id: "b", name: "空き家", sortOrder: 2, autoKey: "vacant", ...letter, ...noLp },
    ]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(findMany.mock.calls[0][0].where).toEqual({ active: true, deletedAt: null });
    const body = await res.json();
    expect(body.allOk).toBe(true);
    expect(body.items.map((i: { level: string }) => i.level)).toEqual(["ok", "ok", "warn"]);
    const text = JSON.stringify(body);
    expect(text).not.toContain("lp.example.com");
    expect(text).not.toContain("03-0000-0000");
    expect(text).not.toContain("本文");
    expect(text).not.toContain("見出し");
  });

  it("設定が足りなければ足りない項目の名前だけを出す", async () => {
    loadSaleDmConfig.mockResolvedValue({ trackingBaseUrl: null, lpUrl: "not-a-url", senderName: " ", senderContact: "x" });
    findMany.mockResolvedValue([]);
    const body = await (await GET()).json();
    expect(body.allOk).toBe(false);
    expect(body.items[0].detail).toBe("未設定: 追跡URL・既定LP URL・差出人名");
  });
});
