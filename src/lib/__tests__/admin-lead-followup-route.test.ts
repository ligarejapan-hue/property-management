import { vi } from "vitest";
vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response { static json = (b: unknown, init?: ResponseInit) => Response.json(b, init); }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error { status: number; code: string; constructor(s: number, m: string, c = "ERROR") { super(m); this.status = s; this.code = c; } }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(), getUserPermissions: vi.fn(),
    parseJsonBody: vi.fn(async (r: Request) => { const t = await r.text(); return t ? JSON.parse(t) : {}; }),
    handleApiError: vi.fn((e: unknown) => {
      if (e instanceof MockApiError) return Response.json({ error: { message: e.message, code: e.code } }, { status: e.status });
      if (e !== null && typeof e === "object" && "issues" in e && Array.isArray((e as Record<string, unknown>).issues)) {
        return Response.json({ error: { code: "VALIDATION_ERROR" } }, { status: 422 });
      }
      return Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 });
    }),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
const tx = {
  mailConfig: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  leadFollowupStep: { deleteMany: vi.fn(), createMany: vi.fn() },
};
vi.mock("@/lib/prisma", () => ({
  default: {
    mailConfig: { findUnique: vi.fn() },
    companyProfile: { findUnique: vi.fn() },
    saleDmConfig: { findUnique: vi.fn() },
    leadFollowupStep: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { GET, PUT } from "../../app/api/admin/lead-followup/route";

const fn = (v: unknown) => v as ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  mailConfig: { findUnique: ReturnType<typeof vi.fn> };
  companyProfile: { findUnique: ReturnType<typeof vi.fn> };
  saleDmConfig: { findUnique: ReturnType<typeof vi.fn> };
  leadFollowupStep: { findMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};
const audit = writeAuditLog as ReturnType<typeof vi.fn>;
const putReq = (b: unknown) => new Request("http://x", { method: "PUT", body: JSON.stringify(b) }) as never;

const mailRow = (o: Record<string, unknown> = {}) => ({
  smtpHost: "smtp.example.test",
  smtpPort: 465,
  smtpUser: "u@example.test",
  smtpPassEnc: "enc",
  fromAddress: "u@example.test",
  followupEnabled: false,
  followupEnabledAt: null,
  followupVersion: 0,
  ...o,
});
const company = { nameJa: "見本不動産", address: "見本県見本市1-2-3", tel: "00-0000-0000", email: null };
const fullSteps = {
  new: [
    { delayDays: 0, subject: "ごあいさつ", body: "本文" },
    { delayDays: 3, subject: "ご連絡", body: "本文" },
  ],
  hold: [{ delayDays: 7, subject: "その後いかがですか", body: "本文" }],
};

let savedSecret: string | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  savedSecret = process.env.NEXTAUTH_SECRET;
  process.env.NEXTAUTH_SECRET = "test-secret-for-followup-settings";
  fn(getApiSession).mockResolvedValue({ id: "11111111-1111-4111-8111-111111111111" });
  fn(getUserPermissions).mockResolvedValue([{ resource: "user_management", action: "write", granted: true }]);
  pm.mailConfig.findUnique.mockResolvedValue(mailRow());
  pm.companyProfile.findUnique.mockResolvedValue(company);
  pm.saleDmConfig.findUnique.mockResolvedValue({ trackingBaseUrl: "https://public.example.test" });
  pm.leadFollowupStep.findMany.mockResolvedValue([]);
  pm.$transaction.mockImplementation((f: (t: typeof tx) => unknown) => f(tx));
  tx.mailConfig.findUnique.mockResolvedValue({ followupEnabled: false, followupEnabledAt: null, followupVersion: 0 });
  tx.mailConfig.updateMany.mockResolvedValue({ count: 1 });
  tx.mailConfig.create.mockResolvedValue({});
  tx.leadFollowupStep.deleteMany.mockResolvedValue({ count: 0 });
  tx.leadFollowupStep.createMany.mockResolvedValue({ count: 3 });
});
afterEach(() => {
  if (savedSecret === undefined) delete process.env.NEXTAUTH_SECRET;
  else process.env.NEXTAUTH_SECRET = savedSecret;
});

describe("GET /api/admin/lead-followup", () => {
  it("管理者(user_management:write)以外は 403", async () => {
    fn(getUserPermissions).mockResolvedValue([{ resource: "user_management", action: "write", granted: false }]);
    expect((await GET()).status).toBe(403);
    expect((await PUT(putReq({ version: 0, enabled: false, steps: { new: [], hold: [] } }))).status).toBe(403);
    expect(pm.$transaction).not.toHaveBeenCalled();
  });

  it("初めては OFF・日数の枠だけ・末尾の見本に会社の情報と外向きの URL", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const { data } = await res.json();
    expect(data.enabled).toBe(false);
    expect(data.version).toBe(0);
    expect(data.usingDefaultSlots).toBe(true);
    expect(data.steps.new.map((s: { delayDays: number }) => s.delayDays)).toEqual([0, 3, 7, 30, 90, 180]);
    expect(data.setupProblems).toEqual([]);
    expect(data.footerPreview).toContain("送信者: 見本不動産");
    expect(data.footerPreview).toContain("https://public.example.test/u/");
  });

  it("一度保存したあと(版1以上)に文面が0件なら、日数の枠を出し直さず空のまま返す", async () => {
    pm.mailConfig.findUnique.mockResolvedValue(mailRow({ followupVersion: 2 }));
    const { data } = await (await GET()).json();
    expect(data.version).toBe(2);
    expect(data.usingDefaultSlots).toBe(false);
    expect(data.steps).toEqual({ new: [], hold: [] });
  });

  it("足りない設定(SMTP・会社名・外向きの URL)を返す", async () => {
    pm.mailConfig.findUnique.mockResolvedValue(mailRow({ smtpPassEnc: null }));
    pm.companyProfile.findUnique.mockResolvedValue({ ...company, nameJa: null });
    pm.saleDmConfig.findUnique.mockResolvedValue({ trackingBaseUrl: null });
    const saved = process.env.SALE_DM_TRACKING_BASE_URL;
    delete process.env.SALE_DM_TRACKING_BASE_URL;
    try {
      const { data } = await (await GET()).json();
      const all = data.setupProblems.join("/");
      expect(all).toContain("メールの送信設定");
      expect(all).toContain("会社名");
      expect(all).toContain("外向きのURL");
    } finally {
      if (saved !== undefined) process.env.SALE_DM_TRACKING_BASE_URL = saved;
    }
  });
});

describe("PUT /api/admin/lead-followup", () => {
  it("ON で保存: 版番号つきで更新・ON にした時刻を入れる・文面は全部を置き換え・監査は数だけ", async () => {
    const res = await PUT(putReq({ version: 0, enabled: true, steps: fullSteps }));
    expect(res.status).toBe(200);
    const upd = tx.mailConfig.updateMany.mock.calls[0][0];
    expect(upd.where).toEqual({ id: "singleton", followupVersion: 0 });
    expect(upd.data.followupEnabled).toBe(true);
    expect(upd.data.followupEnabledAt).toBeInstanceOf(Date);
    expect(upd.data.followupVersion).toEqual({ increment: 1 });
    expect(tx.leadFollowupStep.deleteMany).toHaveBeenCalled();
    const created = tx.leadFollowupStep.createMany.mock.calls[0][0].data;
    expect(created.map((d: { series: string; position: number; delayDays: number }) => [d.series, d.position, d.delayDays])).toEqual([
      ["new", 1, 0],
      ["new", 2, 3],
      ["hold", 1, 7],
    ]);
    const a = audit.mock.calls.at(-1)?.[0];
    expect(a).toMatchObject({ action: "lead_followup_settings_update", targetTable: "mail_config" });
    expect(a.detail).toEqual({ enabled: true, newCount: 2, holdCount: 1 });
    expect(JSON.stringify(a)).not.toContain("ごあいさつ");
  });

  it("ON のまま保存し直しても ON にした時刻は変えない", async () => {
    const at = new Date("2026-11-17T01:00:00Z");
    pm.mailConfig.findUnique.mockResolvedValue(mailRow({ followupEnabled: true, followupEnabledAt: at, followupVersion: 4 }));
    tx.mailConfig.findUnique.mockResolvedValue({ followupEnabled: true, followupEnabledAt: at, followupVersion: 4 });
    await PUT(putReq({ version: 4, enabled: true, steps: fullSteps }));
    expect(tx.mailConfig.updateMany.mock.calls[0][0].data.followupEnabledAt).toBe(at);
  });

  it("版番号が違う(ほかの人が先に保存)なら 409・文面は書かない", async () => {
    tx.mailConfig.findUnique.mockResolvedValue({ followupEnabled: false, followupEnabledAt: null, followupVersion: 2 });
    const res = await PUT(putReq({ version: 1, enabled: false, steps: fullSteps }));
    expect(res.status).toBe(409);
    expect(tx.leadFollowupStep.createMany).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("古い画面(版番号が違う)からの ON の保存は、足りない設定より先に 409(読み直しの案内)", async () => {
    pm.mailConfig.findUnique.mockResolvedValue(mailRow({ followupVersion: 3 }));
    pm.companyProfile.findUnique.mockResolvedValue({ ...company, address: null });
    const res = await PUT(putReq({ version: 2, enabled: true, steps: fullSteps }));
    expect(res.status).toBe(409);
    expect(pm.$transaction).not.toHaveBeenCalled();
  });

  it("行の作成の失敗は、ぶつかり(P2002)だけを 409 にし、ほかは 500 のまま", async () => {
    const { Prisma } = await import("@/generated/prisma");
    tx.mailConfig.findUnique.mockResolvedValue(null);
    pm.mailConfig.findUnique.mockResolvedValue(null);
    tx.mailConfig.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" }),
    );
    expect((await PUT(putReq({ version: 0, enabled: false, steps: fullSteps }))).status).toBe(409);
    tx.mailConfig.create.mockRejectedValueOnce(new Error("connection lost"));
    expect((await PUT(putReq({ version: 0, enabled: false, steps: fullSteps }))).status).toBe(500);
  });

  it("同時の更新で条件付き更新が0件なら 409", async () => {
    tx.mailConfig.updateMany.mockResolvedValue({ count: 0 });
    expect((await PUT(putReq({ version: 0, enabled: false, steps: fullSteps }))).status).toBe(409);
    expect(tx.leadFollowupStep.createMany).not.toHaveBeenCalled();
  });

  it("文面が空の通・会社の設定の欠けがあると ON にできない(422)。OFF なら空のまま保存できる", async () => {
    const blank = { new: [{ delayDays: 0, subject: "", body: "" }], hold: [] };
    const r1 = await PUT(putReq({ version: 0, enabled: true, steps: blank }));
    expect(r1.status).toBe(422);
    expect((await r1.json()).error.code).toBe("FOLLOWUP_NOT_READY");
    pm.companyProfile.findUnique.mockResolvedValue({ ...company, address: null });
    expect((await PUT(putReq({ version: 0, enabled: true, steps: fullSteps }))).status).toBe(422);
    expect(pm.$transaction).not.toHaveBeenCalled();
    expect((await PUT(putReq({ version: 0, enabled: false, steps: blank }))).status).toBe(200);
  });

  it("並びの決まり違反(日数が前の通以下)は 422", async () => {
    const bad = { new: [{ delayDays: 3, subject: "a", body: "b" }, { delayDays: 3, subject: "a", body: "b" }], hold: [] };
    expect((await PUT(putReq({ version: 0, enabled: false, steps: bad }))).status).toBe(422);
    expect(pm.$transaction).not.toHaveBeenCalled();
  });

  it("設定の行がまだ無いときは作る(版番号1)", async () => {
    tx.mailConfig.findUnique.mockResolvedValue(null);
    pm.mailConfig.findUnique.mockResolvedValue(null);
    expect((await PUT(putReq({ version: 0, enabled: false, steps: fullSteps }))).status).toBe(200);
    expect(tx.mailConfig.create.mock.calls[0][0].data).toMatchObject({ id: "singleton", followupVersion: 1, followupEnabled: false });
  });
});
