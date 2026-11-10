import { describe, it, expect, vi, beforeEach } from "vitest";

const { session, perms, db, audit } = vi.hoisted(() => ({
  session: { current: { id: "u1", role: "office_staff" } as { id: string; role: string } },
  perms: { current: [] as { resource: string; action: string; granted: boolean }[] },
  db: { property: { findUnique: vi.fn() }, appraisalDeck: { findFirst: vi.fn() } },
  audit: vi.fn(),
}));

vi.mock("@/lib/api-helpers", () => {
  class ApiError extends Error {
    constructor(public status: number, message: string, public code = "ERROR") {
      super(message);
    }
  }
  return {
    ApiError,
    getApiSession: vi.fn(async () => session.current),
    getUserPermissions: vi.fn(async () => perms.current),
    handleApiError: (e: unknown) => {
      const err = e as { status?: number; message?: string; code?: string };
      return Response.json({ error: { message: err.message, code: err.code } }, { status: err.status ?? 500 });
    },
  };
});
vi.mock("@/lib/uploads-authorization", () => ({
  canOpenReferralDocument: (p: { resource: string; action: string; granted: boolean }[]) =>
    p.some((x) => x.resource === "owner" && x.action === "read" && x.granted),
}));
vi.mock("@/lib/prisma", () => ({ default: db }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: audit }));

import { GET } from "../[deckId]/view/route";

const P = (r: string, a: string) => ({ resource: r, action: a, granted: true });
const EXTRACTED = {
  parserVersion: 1,
  source: "sre",
  kind: "house",
  appraisedOn: "2026-08-24",
  area: "東京都架空区見本町4丁目",
  expected: { total: 1304, tsubo: null, land: 1214, landTsubo: 88, building: 90, buildingTsubo: 4.6 },
  ai: { total: 4137, tsubo: null, land: 4047, landTsubo: 293.5, building: 90, buildingTsubo: 4.6 },
  adjustment: { landPercent: -70, landAmount: null, landReason: null, liquidityPercent: 0, items: [] },
  plans: [{ name: "standard", price: 1280, tsubo: null }],
  range: null,
  warnings: [],
};
const ctx = { params: Promise.resolve({ id: "p1", deckId: "d1" }) };
const req = (q = "") => new Request(`http://t/x${q}`);

beforeEach(() => {
  vi.clearAllMocks();
  session.current = { id: "u1", role: "office_staff" };
  perms.current = [P("property", "read"), P("owner", "read")];
  db.property.findUnique.mockResolvedValue({ id: "p1", createdBy: "u9", assignedTo: null, isArchived: false });
  db.appraisalDeck.findFirst.mockResolvedValue({ id: "d1", status: "confirmed", extracted: EXTRACTED, overrides: {} });
});

describe("資料の表示・ダウンロード", () => {
  it("所有者の情報を見られない人・担当外は 403", async () => {
    perms.current = [P("property", "read")];
    expect((await GET(req(), ctx)).status).toBe(403);
    perms.current = [P("property", "read"), P("owner", "read")];
    session.current = { id: "u1", role: "field_staff" };
    expect((await GET(req(), ctx)).status).toBe(403);
  });
  it("表示は HTML・外へ通信しない CSP・キャッシュしない", async () => {
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Content-Security-Policy")).toContain("connect-src 'none'");
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(res.headers.get("Content-Disposition")).toBeNull();
    expect(audit).not.toHaveBeenCalled();
  });
  it("確認前も表示はできる(左上に確認前)・ダウンロードは 409", async () => {
    db.appraisalDeck.findFirst.mockResolvedValue({ id: "d1", status: "draft", extracted: EXTRACTED, overrides: {} });
    const html = await (await GET(req(), ctx)).text();
    expect(html).toContain('"draft":true');
    expect((await GET(req("?download=1"), ctx)).status).toBe(409);
    expect(audit).not.toHaveBeenCalled();
  });
  it("確認済みはファイルとして保存し、AuditLog に id だけ残す", async () => {
    const res = await GET(req("?download=1"), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    expect(res.headers.get("Content-Disposition")).toContain(encodeURIComponent("査定のご報告_2026-08-24.html"));
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "appraisal_deck_download", targetTable: "appraisal_decks", targetId: "d1", detail: { propertyId: "p1" } }),
    );
  });
  it("別の物件の資料は 404", async () => {
    db.appraisalDeck.findFirst.mockResolvedValue(null);
    expect((await GET(req(), ctx)).status).toBe(404);
    expect(db.appraisalDeck.findFirst.mock.calls[0][0].where).toEqual({ id: "d1", propertyId: "p1" });
  });
});
