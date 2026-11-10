import { describe, it, expect, vi, beforeEach } from "vitest";

const { session, perms, db, build, audit } = vi.hoisted(() => ({
  session: { current: { id: "u1", role: "office_staff" } as { id: string; role: string } },
  perms: { current: [] as { resource: string; action: string; granted: boolean }[] },
  db: {
    property: { findUnique: vi.fn() },
    appraisalDeck: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  },
  build: vi.fn(),
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
    parseJsonBody: async (req: Request) => {
      const t = await req.text();
      return t.trim() ? JSON.parse(t) : {};
    },
    apiResponse: (data: unknown, status = 200) => Response.json(data, { status }),
    handleApiError: (e: unknown) => {
      const err = e as { status?: number; message?: string; code?: string };
      return Response.json({ error: { message: err.message, code: err.code } }, { status: err.status ?? 500 });
    },
  };
});
vi.mock("@/lib/uploads-authorization", () => ({
  // 査定報告書を開ける人 = 所有者の情報を伏せずに見られる人(ここでは owner:read で代用)
  canOpenReferralDocument: (p: { resource: string; action: string; granted: boolean }[]) =>
    p.some((x) => x.resource === "owner" && x.action === "read" && x.granted),
}));
vi.mock("@/lib/prisma", () => ({ default: db }));
vi.mock("@/lib/appraisal-deck/create-draft", () => ({ buildAppraisalDraft: build }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: audit }));

import { GET as listGET, POST as listPOST } from "../route";
import { GET as deckGET, PATCH as deckPATCH } from "../[deckId]/route";
import { POST as confirmPOST } from "../[deckId]/confirm/route";

const P = (r: string, a: string) => ({ resource: r, action: a, granted: true });
const FULL = [P("property", "read"), P("property", "write"), P("owner", "read")];
const EXTRACTED = {
  kind: "house",
  appraisedOn: "2026-08-24",
  expected: { total: 1304, tsubo: null, land: 1214, landTsubo: 88, building: 90, buildingTsubo: 4.6 },
  ai: { total: 4137 },
  adjustment: { landPercent: -70, items: [] },
  plans: [{ name: "standard", price: 1280, tsubo: null }],
  range: null,
  warnings: ["plan_order"],
};
const DECK = {
  id: "d1",
  propertyId: "p1",
  status: "draft",
  sourceAttachmentId: "a1",
  parserVersion: 1,
  extracted: EXTRACTED,
  overrides: {},
  createdAt: new Date("2026-11-10"),
  updatedAt: new Date("2026-11-10T01:00:00Z"),
  confirmedAt: null,
};
const ctx = { params: Promise.resolve({ id: "p1" }) };
const dctx = { params: Promise.resolve({ id: "p1", deckId: "d1" }) };
const req = (method: string, body?: unknown) =>
  new Request("http://t/x", { method, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  session.current = { id: "u1", role: "office_staff" };
  perms.current = FULL;
  db.property.findUnique.mockResolvedValue({ id: "p1", createdBy: "u9", assignedTo: null, isArchived: false });
  db.appraisalDeck.findMany.mockResolvedValue([DECK]);
  db.appraisalDeck.findFirst.mockResolvedValue(DECK);
  db.appraisalDeck.update.mockResolvedValue({});
  db.appraisalDeck.updateMany.mockResolvedValue({ count: 1 });
  build.mockResolvedValue({ ok: true, deckId: "d1", created: true });
});

describe("権限(査定報告書を開ける人と同じ範囲)", () => {
  const calls: Array<[string, () => Promise<Response>]> = [
    ["一覧", () => listGET(req("GET"), ctx)],
    ["作り直し", () => listPOST(req("POST", { attachmentId: "0b6f6c1e-0000-4000-8000-000000000000" }), ctx)],
    ["詳細", () => deckGET(req("GET"), dctx)],
    ["修正", () => deckPATCH(req("PATCH", { overrides: {} }), dctx)],
    ["確認", () => confirmPOST(req("POST"), dctx)],
  ];
  it.each(calls)("%s: 所有者の情報を見られない人は 403", async (_n, call) => {
    perms.current = [P("property", "read"), P("property", "write")];
    expect((await call()).status).toBe(403);
    expect(db.appraisalDeck.findMany).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });
  it.each(calls)("%s: 担当外の物件(field_staff)は 403", async (_n, call) => {
    session.current = { id: "u1", role: "field_staff" };
    expect((await call()).status).toBe(403);
  });
  it("閲覧だけの人は見られるが、直せない", async () => {
    perms.current = [P("property", "read"), P("owner", "read")];
    expect((await listGET(req("GET"), ctx)).status).toBe(200);
    expect((await deckPATCH(req("PATCH", { overrides: {} }), dctx)).status).toBe(403);
    expect((await confirmPOST(req("POST"), dctx)).status).toBe(403);
  });
});

describe("GET 一覧", () => {
  it("状態と注意の数だけを返す(数字は返さない)", async () => {
    const body = await (await listGET(req("GET"), ctx)).json();
    expect(body.decks[0]).toMatchObject({ id: "d1", status: "draft", kind: "house", appraisedOn: "2026-08-24", warningCount: 1 });
    expect(JSON.stringify(body)).not.toContain("1304");
  });
});

describe("POST 作り直し", () => {
  it("作り直しで呼び、結果を返す", async () => {
    const res = await listPOST(req("POST", { attachmentId: "0b6f6c1e-0000-4000-8000-000000000000" }), ctx);
    expect(res.status).toBe(201);
    expect(build).toHaveBeenCalledWith({
      attachmentId: "0b6f6c1e-0000-4000-8000-000000000000",
      propertyId: "p1",
      userId: "u1",
      replace: true,
    });
  });
  it.each([
    ["already_confirmed", 409],
    ["not_sre", 422],
    ["attachment_not_found", 404],
  ])("%s → %i", async (reason, status) => {
    build.mockResolvedValue({ ok: false, reason });
    expect((await listPOST(req("POST", { attachmentId: "0b6f6c1e-0000-4000-8000-000000000000" }), ctx)).status).toBe(status);
  });
  it("しまってある物件では作らない", async () => {
    db.property.findUnique.mockResolvedValue({ id: "p1", createdBy: "u9", assignedTo: null, isArchived: true });
    expect((await listPOST(req("POST", { attachmentId: "0b6f6c1e-0000-4000-8000-000000000000" }), ctx)).status).toBe(422);
    expect(build).not.toHaveBeenCalled();
  });
});

describe("PATCH 修正", () => {
  it("知らない項目は 422(依頼者名などを入れる口を作らない)", async () => {
    expect((await deckPATCH(req("PATCH", { overrides: { ownerName: "x" } }), dctx)).status).toBe(422);
    expect(db.appraisalDeck.update).not.toHaveBeenCalled();
  });
  it("確認済みを直すと下書きに戻し、AuditLog に数字を残さない", async () => {
    db.appraisalDeck.findFirst.mockResolvedValue({ ...DECK, status: "confirmed" });
    const res = await deckPATCH(req("PATCH", { overrides: { expected: { total: 1350 } } }), dctx);
    expect(res.status).toBe(200);
    expect(db.appraisalDeck.update.mock.calls[0][0].data).toMatchObject({ status: "draft", confirmedAt: null, confirmedBy: null });
    expect(JSON.stringify(audit.mock.calls[0][0].detail)).not.toContain("1350");
  });
  it("別の物件の資料は 404", async () => {
    db.appraisalDeck.findFirst.mockResolvedValue(null);
    expect((await deckPATCH(req("PATCH", { overrides: {} }), dctx)).status).toBe(404);
    expect(db.appraisalDeck.findFirst.mock.calls[0][0].where).toEqual({ id: "d1", propertyId: "p1" });
  });
});

describe("POST 確認", () => {
  it("読んだ時点の版・下書きを条件に確認済みにする", async () => {
    expect((await confirmPOST(req("POST"), dctx)).status).toBe(200);
    expect(db.appraisalDeck.updateMany.mock.calls[0][0].where).toEqual({ id: "d1", status: "draft", updatedAt: DECK.updatedAt });
  });
  it("ほかで直されていたら 409", async () => {
    db.appraisalDeck.updateMany.mockResolvedValue({ count: 0 });
    expect((await confirmPOST(req("POST"), dctx)).status).toBe(409);
  });
  it("成約想定価格・売出し価格が無いままでは確認済みにしない", async () => {
    db.appraisalDeck.findFirst.mockResolvedValue({ ...DECK, extracted: { ...EXTRACTED, expected: { total: null } } });
    expect((await confirmPOST(req("POST"), dctx)).status).toBe(422);
    db.appraisalDeck.findFirst.mockResolvedValue({ ...DECK, extracted: { ...EXTRACTED, plans: [], range: null } });
    expect((await confirmPOST(req("POST"), dctx)).status).toBe(422);
    expect(db.appraisalDeck.updateMany).not.toHaveBeenCalled();
  });
  it("担当者の修正で埋めた数字なら確認できる", async () => {
    db.appraisalDeck.findFirst.mockResolvedValue({
      ...DECK,
      extracted: { ...EXTRACTED, expected: { total: null }, plans: [] },
      overrides: { expected: { total: 1300 }, range: { min: 1200, max: 1400, minTsubo: null, maxTsubo: null } },
    });
    expect((await confirmPOST(req("POST"), dctx)).status).toBe(200);
  });
});
