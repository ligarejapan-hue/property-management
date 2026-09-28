import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", async () => (await import("./agent-inquiry-route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./agent-inquiry-route-mocks")).apiHelpersMock());
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    agentInquiry: {
      create: vi.fn(),
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 1 })),
      count: vi.fn(async () => 0),
    },
    agentViewing: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
    agent: { findUnique: vi.fn(async () => null) },
    property: { findUnique: vi.fn(async () => null) },
    user: { findUnique: vi.fn(async () => ({ isActive: true })) },
  };
  return { default: db };
});

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { jsonRequest as json } from "./agent-inquiry-route-mocks";
import { GET as LIST, POST } from "../../app/api/agent-inquiries/route";
import { GET as GET_ONE, PATCH } from "../../app/api/agent-inquiries/[id]/route";
import { GET as COUNTS } from "../../app/api/agent-inquiries/counts/route";
import { GET as UPCOMING } from "../../app/api/agent-inquiries/upcoming/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  agentInquiry: { create: Fn; findMany: Fn; findUnique: Fn; updateMany: Fn; count: Fn };
  agentViewing: { count: Fn; findMany: Fn };
  agent: { findUnique: Fn };
  property: { findUnique: Fn };
  user: { findUnique: Fn };
};
const PID = "11111111-1111-4111-8111-111111111111";
const AID = "22222222-2222-4222-8222-222222222222";
const IID = "44444444-4444-4444-8444-444444444444";
const UID = "66666666-6666-4666-8666-666666666666";
const ctx = { params: Promise.resolve({ id: IID }) };
const deskRow = {
  id: PID, propertyType: "land", buildingName: null, roomNo: null,
  address: "東京都中野区中野2丁目3", building: null, adPermissions: [],
};
const DESK_KEYS = ["adPermissions", "id", "name", "propertyType", "roomNo", "town"];

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u-field", role: "field_staff" });
  (getUserPermissions as Fn).mockResolvedValue([
    { resource: "agent_inquiry", action: "read", granted: true },
    { resource: "agent_inquiry", action: "write", granted: true },
  ]);
  pm.property.findUnique.mockResolvedValue({ id: PID });
  pm.agent.findUnique.mockResolvedValue({ id: AID, isArchived: false });
  pm.agentInquiry.create.mockResolvedValue({ id: IID });
  pm.user.findUnique.mockResolvedValue({ isActive: true });
});

describe("反響 API", () => {
  it("現地スタッフが担当外の物件にも登録できる・担当=登録者・状態=未対応・内見も同時に", async () => {
    const res = await POST(json("POST", {
      propertyId: PID, agentId: AID, kind: "viewing", contactMobile: "09012345678",
      viewing: { viewingType: "guided", scheduledAt: "2026-10-02T05:00:00.000Z" },
    }));
    expect(res.status).toBe(201);
    expect(pm.property.findUnique).toHaveBeenCalledWith({ where: { id: PID }, select: { id: true } });
    expect(pm.agentInquiry.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      propertyId: PID, agentId: AID, assigneeId: "u-field", createdById: "u-field", status: "open", contactMobile: "090-1234-5678",
      viewings: { create: [expect.objectContaining({ viewingType: "guided", scheduledAt: new Date("2026-10-02T05:00:00.000Z") })] },
    }) }));
  });
  it("存在しない物件は 404・しまった業者は 409", async () => {
    pm.property.findUnique.mockResolvedValueOnce(null);
    expect((await POST(json("POST", { propertyId: PID, agentId: AID, kind: "viewing" }))).status).toBe(404);
    pm.agent.findUnique.mockResolvedValueOnce({ id: AID, isArchived: true });
    expect((await POST(json("POST", { propertyId: PID, agentId: AID, kind: "viewing" }))).status).toBe(409);
  });
  it("立ち会いに無効な利用者は 422", async () => {
    pm.user.findUnique.mockResolvedValueOnce({ isActive: false });
    const res = await POST(json("POST", {
      propertyId: PID, agentId: AID, kind: "viewing", viewing: { viewingType: "guided", attendantId: UID },
    }));
    expect(res.status).toBe(422);
  });
  it("監査に携帯・メール・メモの値を書かない", async () => {
    await POST(json("POST", {
      propertyId: PID, agentId: AID, kind: "material_request",
      contactMobile: "09012345678", contactEmail: "t@x.jp", note: "本文ABC",
    }));
    const s = JSON.stringify((writeAuditLog as Fn).mock.calls);
    expect(s).not.toMatch(/090-?1234-?5678|t@x\.jp|本文ABC/);
    expect(s).toContain("agent_inquiry_create");
  });
  it("一覧の物件は許可リストのキーだけ", async () => {
    pm.agentInquiry.findMany.mockResolvedValue([
      { id: IID, kind: "viewing", status: "open", viewings: [], property: { ...deskRow, salePrice: 1, lotNumber: "9" } },
    ]);
    const body = await (await LIST(new Request("http://x/api/agent-inquiries?status=open"))).json();
    expect(Object.keys(body.items[0].property).sort()).toEqual(DESK_KEYS);
    expect(JSON.stringify(body)).not.toMatch(/lotNumber|salePrice/);
    expect(pm.agentInquiry.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: "open" }, take: 51 }));
  });
  it("assignee=me は自分の id で絞る", async () => {
    await LIST(new Request("http://x/api/agent-inquiries?assignee=me"));
    expect(pm.agentInquiry.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { assigneeId: "u-field" } }));
  });
  it("詳細の canOpenProperty は物件の閲覧権限と現地スタッフの担当範囲で決まる・担当範囲の列は返さない", async () => {
    (getUserPermissions as Fn).mockResolvedValue([
      { resource: "agent_inquiry", action: "read", granted: true },
      { resource: "property", action: "read", granted: true },
    ]);
    pm.agentInquiry.findUnique.mockResolvedValue({ id: IID, viewings: [], property: { ...deskRow, createdBy: "other", assignedTo: "other" } });
    let body = await (await GET_ONE(new Request("http://x"), ctx)).json();
    expect(body.canOpenProperty).toBe(false);
    expect(Object.keys(body.inquiry.property).sort()).toEqual(DESK_KEYS);
    pm.agentInquiry.findUnique.mockResolvedValue({ id: IID, viewings: [], property: { ...deskRow, createdBy: "u-field", assignedTo: null } });
    body = await (await GET_ONE(new Request("http://x"), ctx)).json();
    expect(body.canOpenProperty).toBe(true);
  });
  it("変更: 古い版は 409・監査は項目名と状態の値だけ", async () => {
    pm.agentInquiry.updateMany.mockResolvedValueOnce({ count: 0 });
    pm.agentInquiry.findUnique.mockResolvedValueOnce({ id: IID });
    expect((await PATCH(json("PATCH", { status: "done", version: 1 }), ctx)).status).toBe(409);
    await PATCH(json("PATCH", { status: "done", note: "メモXYZ", version: 2 }), ctx);
    const last = (writeAuditLog as Fn).mock.calls.at(-1)![0];
    expect(last.detail).toEqual({ changed: ["note", "status"], status: "done" });
  });
  it("担当者の振り替えは有効な利用者だけ", async () => {
    pm.user.findUnique.mockResolvedValueOnce(null);
    expect((await PATCH(json("PATCH", { assigneeId: UID, version: 1 }), ctx)).status).toBe(422);
    expect(pm.agentInquiry.updateMany).not.toHaveBeenCalled();
  });
  it("件数: 未対応と今日明日の内見(取り消し除く)", async () => {
    pm.agentInquiry.count.mockResolvedValue(3);
    pm.agentViewing.count.mockResolvedValue(2);
    expect(await (await COUNTS()).json()).toEqual({ open: 3, upcomingViewings: 2 });
    expect(pm.agentViewing.count).toHaveBeenCalledWith({ where: expect.objectContaining({ canceledAt: null }) });
  });
  it("今日明日の内見の物件は許可リストだけ", async () => {
    pm.agentViewing.findMany.mockResolvedValue([{
      id: "v", scheduledAt: new Date(), viewingType: "guided", attendant: null,
      inquiry: { id: IID, contactName: "田中", agent: { companyName: "○○" }, property: { ...deskRow, salePrice: 1 } },
    }]);
    const body = await (await UPCOMING()).json();
    expect(Object.keys(body.viewings[0].inquiry.property).sort()).toEqual(DESK_KEYS);
  });
});
