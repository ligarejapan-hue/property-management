import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", async () => (await import("./agent-inquiry-route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./agent-inquiry-route-mocks")).apiHelpersMock());
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    agentInquiry: { findUnique: vi.fn(async () => null) },
    agentViewing: { create: vi.fn(), findFirst: vi.fn(async () => null), update: vi.fn(async () => ({})) },
    user: { findUnique: vi.fn(async () => ({ isActive: true })) },
  };
  return { default: db };
});

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { jsonRequest as json } from "./agent-inquiry-route-mocks";
import { POST as ADD } from "../../app/api/agent-inquiries/[id]/viewings/route";
import { PATCH as EDIT } from "../../app/api/agent-inquiries/[id]/viewings/[vid]/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  agentInquiry: { findUnique: Fn };
  agentViewing: { create: Fn; findFirst: Fn; update: Fn };
  user: { findUnique: Fn };
};
const IID = "44444444-4444-4444-8444-444444444444";
const VID = "55555555-5555-4555-8555-555555555555";
const UID = "66666666-6666-4666-8666-666666666666";
const addCtx = { params: Promise.resolve({ id: IID }) };
const editCtx = { params: Promise.resolve({ id: IID, vid: VID }) };

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u1", role: "field_staff" });
  (getUserPermissions as Fn).mockResolvedValue([{ resource: "agent_inquiry", action: "write", granted: true }]);
  pm.user.findUnique.mockResolvedValue({ isActive: true });
});

describe("内見の予定 API", () => {
  it("用件が内見でない反響には追加できない(409 NOT_VIEWING)", async () => {
    pm.agentInquiry.findUnique.mockResolvedValue({ id: IID, kind: "ad_permission" });
    const res = await ADD(json("POST", { viewingType: "guided" }), addCtx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("NOT_VIEWING");
  });
  it("追加: 日時なし(日程調整中)も可", async () => {
    pm.agentInquiry.findUnique.mockResolvedValue({ id: IID, kind: "viewing" });
    pm.agentViewing.create.mockResolvedValue({ id: VID });
    expect((await ADD(json("POST", { viewingType: "preview" }), addCtx)).status).toBe(201);
    expect(pm.agentViewing.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ inquiryId: IID, scheduledAt: null }),
    }));
  });
  it("追加: 立ち会いに無効な利用者は 422", async () => {
    pm.agentInquiry.findUnique.mockResolvedValue({ id: IID, kind: "viewing" });
    pm.user.findUnique.mockResolvedValueOnce(null);
    expect((await ADD(json("POST", { viewingType: "guided", attendantId: UID }), addCtx)).status).toBe(422);
    expect(pm.agentViewing.create).not.toHaveBeenCalled();
  });
  it("別の反響の内見 id は 404", async () => {
    pm.agentViewing.findFirst.mockResolvedValue(null);
    const res = await EDIT(json("PATCH", { canceled: true }), editCtx);
    expect(res.status).toBe(404);
    expect(pm.agentViewing.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: VID, inquiryId: IID } }));
  });
  it("取り消しと結果・監査に結果の文面を書かない", async () => {
    pm.agentViewing.findFirst.mockResolvedValue({ id: VID });
    await EDIT(json("PATCH", { canceled: true, resultNote: "駅距離で見送り" }), editCtx);
    expect(pm.agentViewing.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ canceledAt: expect.any(Date), resultNote: "駅距離で見送り" }),
    }));
    expect(JSON.stringify((writeAuditLog as Fn).mock.calls)).not.toContain("駅距離");
  });
  it("取り消しを戻す", async () => {
    pm.agentViewing.findFirst.mockResolvedValue({ id: VID });
    await EDIT(json("PATCH", { canceled: false }), editCtx);
    expect(pm.agentViewing.update).toHaveBeenCalledWith({ where: { id: VID }, data: { canceledAt: null } });
  });
  it("権限が無ければ 403", async () => {
    (getUserPermissions as Fn).mockResolvedValue([{ resource: "agent_inquiry", action: "read", granted: true }]);
    expect((await EDIT(json("PATCH", { canceled: true }), editCtx)).status).toBe(403);
  });
});
