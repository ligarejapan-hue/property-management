import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", async () => (await import("./agent-inquiry-route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./agent-inquiry-route-mocks")).apiHelpersMock());
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    agentInquiry: {
      create: vi.fn(),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    agent: { findUnique: vi.fn(async () => null) },
    property: { findUnique: vi.fn(async () => null) },
    user: { findUnique: vi.fn(async () => ({ isActive: true })) },
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { default: db };
});
vi.mock("@/lib/property-record-guard", () => ({ lockPropertyRow: vi.fn() }));

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { jsonRequest as json } from "./agent-inquiry-route-mocks";
import { POST } from "../../app/api/agent-inquiries/route";
import { PATCH } from "../../app/api/agent-inquiries/[id]/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  agentInquiry: { create: Fn; findFirst: Fn; findUnique: Fn; updateMany: Fn };
  agent: { findUnique: Fn };
  property: { findUnique: Fn };
};
const PID = "11111111-1111-4111-8111-111111111111";
const AID = "22222222-2222-4222-8222-222222222222";
const IID = "44444444-4444-4444-8444-444444444444";
const ctx = { params: Promise.resolve({ id: IID }) };

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Fn).mockResolvedValue([
    { resource: "agent_inquiry", action: "read", granted: true },
    { resource: "agent_inquiry", action: "write", granted: true },
  ]);
  pm.property.findUnique.mockResolvedValue({ id: PID, isArchived: false });
  pm.agent.findUnique.mockResolvedValue({ id: AID, isArchived: false });
  pm.agentInquiry.create.mockResolvedValue({ id: IID });
  pm.agentInquiry.updateMany.mockResolvedValue({ count: 1 });
});

describe("名簿に入れずに反響を受け付ける(2026-11-25)", () => {
  it("名前だけで登録できる=名簿の業者は確かめず agentId は null・名前は前後の空白を落とす", async () => {
    const res = await POST(json("POST", { propertyId: PID, agentNameText: "  山田工務店 ", kind: "ad_permission" }));
    expect(res.status).toBe(201);
    expect(pm.agent.findUnique).not.toHaveBeenCalled();
    expect(pm.agentInquiry.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ agentId: null, agentNameText: "山田工務店" }) }),
    );
    // 監査は項目名だけ(名前の中身は書かない)
    const detail = writeAuditLog.mock.calls[0][0].detail;
    expect(detail.changed).toContain("agentNameText");
    expect(JSON.stringify(detail)).not.toContain("山田工務店");
  });

  it("名簿の業者を選んだときは今までどおり(名前は保存しない)", async () => {
    await POST(json("POST", { propertyId: PID, agentId: AID, kind: "ad_permission" }));
    expect(pm.agentInquiry.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ agentId: AID, agentNameText: null }) }),
    );
  });

  it("業者も名前も無い・両方ある・名前が空白だけ=422(業者の分からない反響を作らない)", async () => {
    expect((await POST(json("POST", { propertyId: PID, kind: "ad_permission" }))).status).toBe(422);
    expect((await POST(json("POST", { propertyId: PID, agentNameText: "   ", kind: "ad_permission" }))).status).toBe(422);
    expect(
      (await POST(json("POST", { propertyId: PID, agentId: AID, agentNameText: "山田", kind: "ad_permission" }))).status,
    ).toBe(422);
    expect(pm.agentInquiry.create).not.toHaveBeenCalled();
  });

  it("あとで名簿の業者に付け替える=名簿に入れていない反響だけ・名前は消す", async () => {
    const res = await PATCH(json("PATCH", { agentId: AID, version: 3 }), ctx);
    expect(res.status).toBe(200);
    expect(pm.agentInquiry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: IID, version: 3, agentId: null },
        data: expect.objectContaining({ agentId: AID, agentNameText: null }),
      }),
    );
  });

  it("もう名簿の業者が付いている反響は付け替えない=409", async () => {
    pm.agentInquiry.updateMany.mockResolvedValue({ count: 0 });
    pm.agentInquiry.findUnique.mockResolvedValue({ id: IID, version: 3, agentId: AID });
    const res = await PATCH(json("PATCH", { agentId: AID, version: 3 }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("AGENT_ALREADY_SET");
  });

  it("しまわれた業者には付け替えない", async () => {
    pm.agent.findUnique.mockResolvedValue({ id: AID, isArchived: true });
    expect((await PATCH(json("PATCH", { agentId: AID, version: 3 }), ctx)).status).toBe(409);
    expect(pm.agentInquiry.updateMany).not.toHaveBeenCalled();
  });

  it("付け替え以外の変更では業者の条件を足さない", async () => {
    await PATCH(json("PATCH", { status: "done", version: 1 }), ctx);
    expect(pm.agentInquiry.updateMany.mock.calls[0][0].where).toEqual({ id: IID, version: 1 });
  });
});
