import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", async () => (await import("./agent-inquiry-route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./agent-inquiry-route-mocks")).apiHelpersMock());
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    agent: {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: "a-new" })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    agentInquiry: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => []),
  };
  return { default: db };
});

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { jsonRequest as json } from "./agent-inquiry-route-mocks";
import { GET as SEARCH, POST } from "../../app/api/agents/route";
import { GET as DETAIL, PATCH } from "../../app/api/agents/[id]/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  agent: { findMany: Fn; findUnique: Fn; create: Fn; updateMany: Fn };
  agentInquiry: { findMany: Fn };
  $queryRaw: Fn;
};
const AID = "22222222-2222-4222-8222-222222222222";
const ctx = { params: Promise.resolve({ id: AID }) };
const grant = (...actions: string[]) =>
  (getUserPermissions as Fn).mockResolvedValue(actions.map((a) => ({ resource: "agent_inquiry", action: a, granted: true })));

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u1", role: "field_staff" });
  grant("read", "write");
});

describe("業者 API", () => {
  it("権限が無ければ 403", async () => {
    grant();
    expect((await SEARCH(new Request("http://x/api/agents?q=" + encodeURIComponent("不動産")))).status).toBe(403);
    grant("read");
    expect((await POST(json("POST", { companyName: "x", phone: "0312345678" }))).status).toBe(403);
  });
  it("現地スタッフも登録できる・電話はハイフン入りで保存・登録者を記録", async () => {
    const res = await POST(json("POST", { companyName: " △△住宅 ", phone: "0398765432" }));
    expect(res.status).toBe(201);
    expect(pm.agent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ companyName: "△△住宅", phone: "03-9876-5432", createdById: "u1" }),
    }));
  });
  it("監査に電話・メール・メモの値を書かない", async () => {
    await POST(json("POST", { companyName: "x", phone: "0398765432", email: "a@b.jp", note: "秘密のメモ" }));
    const s = JSON.stringify((writeAuditLog as Fn).mock.calls);
    expect(s).not.toMatch(/03-9876-5432|0398765432|a@b\.jp|秘密のメモ/);
    expect(s).toContain("agent_create");
  });
  it("7桁以上の数字は数字照合(代表電話+反響の携帯)に回す", async () => {
    await SEARCH(new Request("http://x/api/agents?q=090-1234-5"));
    expect(pm.$queryRaw).toHaveBeenCalledTimes(1);
    expect(pm.agent.findMany).not.toHaveBeenCalled();
  });
  it("文字は商号・ふりがな・支店の部分一致・しまった業者を除く・20件まで", async () => {
    await SEARCH(new Request("http://x/api/agents?q=" + encodeURIComponent("不動産")));
    expect(pm.agent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { isArchived: false, OR: [
        { companyName: { contains: "不動産", mode: "insensitive" } },
        { companyKana: { contains: "不動産", mode: "insensitive" } },
        { branchName: { contains: "不動産", mode: "insensitive" } },
      ] },
      take: 20,
    }));
  });
  it("全角の会社名(ＡＢＣ)も半角で打った語で当たる(レビュー Important 2)", async () => {
    await SEARCH(new Request("http://x/api/agents?q=ABC"));
    const or = pm.agent.findMany.mock.calls[0][0].where.OR as { companyName?: { contains: string } }[];
    expect(or.filter((c) => c.companyName).map((c) => c.companyName!.contains).sort()).toEqual(["ABC", "ＡＢＣ"].sort());
  });
  it("名簿の一覧(list=1): 名前順・反響件数と最終日つき・しまった業者は archived=1 で見られる(レビュー Important 3)", async () => {
    pm.agent.findMany.mockResolvedValueOnce([{
      id: AID, companyName: "○○", branchName: null, phone: "03-1", isArchived: true,
      _count: { inquiries: 12 }, inquiries: [{ receivedAt: new Date("2026-10-02T00:00:00Z") }],
    }]);
    const body = await (await SEARCH(new Request("http://x/api/agents?list=1&archived=1"))).json();
    const arg = pm.agent.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ isArchived: true });
    expect(arg.orderBy).toEqual([{ companyName: "asc" }, { id: "asc" }]);
    expect(body.agents).toEqual([{
      id: AID, companyName: "○○", branchName: null, phone: "03-1", isArchived: true,
      inquiryCount: 12, lastReceivedAt: "2026-10-02T00:00:00.000Z",
    }]);
    expect(body.nextCursor).toBeNull();
  });
  it("名簿の一覧の既定は使っている業者だけ", async () => {
    await SEARCH(new Request("http://x/api/agents?list=1"));
    expect(pm.agent.findMany.mock.calls[0][0].where).toEqual({ isArchived: false });
  });
  it("同じ業者が代表電話と携帯の両方で当たったら携帯側(問い合わせ者つき)を残す", async () => {
    pm.$queryRaw.mockResolvedValueOnce([
      { id: AID, company_name: "○○", branch_name: null, phone: "03-1", c_name: null, c_mobile: null, c_email: null, matched_by: "phone" },
      { id: AID, company_name: "○○", branch_name: null, phone: "03-1", c_name: "田中", c_mobile: "090-1234-5678", c_email: "t@x.jp", matched_by: "mobile" },
    ]);
    const body = await (await SEARCH(new Request("http://x/api/agents?q=09012345678"))).json();
    expect(body.agents).toEqual([{ id: AID, companyName: "○○", branchName: null, phone: "03-1", matchedBy: "mobile",
      lastContact: { name: "田中", mobile: "090-1234-5678", email: "t@x.jp" } }]);
  });
  it("業者の反響の履歴はページ送り(続きがあれば nextCursor・@codex #454 R7)", async () => {
    pm.agent.findUnique.mockResolvedValueOnce({ id: AID, companyName: "○○" });
    const row = (n: number) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, kind: "viewing", status: "open",
      receivedAt: new Date(), contactName: null,
      property: { id: "p", propertyType: "land", buildingName: null, roomNo: null, address: "東京都中野区本町", building: null, adPermissions: [] } });
    pm.agentInquiry.findMany.mockResolvedValueOnce(Array.from({ length: 51 }, (_, n) => row(n)));
    const body = await (await DETAIL(new Request("http://x/api/agents/" + AID), ctx)).json();
    expect(body.inquiries).toHaveLength(50);
    expect(body.nextCursor).toBe(row(49).id);
    const arg = pm.agentInquiry.findMany.mock.calls[0][0];
    expect(arg.take).toBe(51);
    expect(arg.orderBy).toEqual([{ receivedAt: "desc" }, { id: "desc" }]);
  });
  it("cursor を渡すと続きから", async () => {
    pm.agent.findUnique.mockResolvedValueOnce({ id: AID, companyName: "○○" });
    const C = "33333333-3333-4333-8333-333333333333";
    await DETAIL(new Request("http://x/api/agents/" + AID + "?cursor=" + C), ctx);
    expect(pm.agentInquiry.findMany.mock.calls[0][0]).toEqual(expect.objectContaining({ cursor: { id: C }, skip: 1 }));
  });
  it("古い版からの変更は 409 VERSION_CONFLICT", async () => {
    pm.agent.updateMany.mockResolvedValueOnce({ count: 0 });
    pm.agent.findUnique.mockResolvedValueOnce({ id: AID });
    const res = await PATCH(json("PATCH", { companyName: "y", version: 2 }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("VERSION_CONFLICT");
  });
  it("存在しない業者の変更は 404", async () => {
    pm.agent.updateMany.mockResolvedValueOnce({ count: 0 });
    pm.agent.findUnique.mockResolvedValueOnce(null);
    expect((await PATCH(json("PATCH", { companyName: "y", version: 1 }), ctx)).status).toBe(404);
  });
  it("触っていない列は更新しない(PATCH で null にしない)", async () => {
    await PATCH(json("PATCH", { isArchived: true, version: 1 }), ctx);
    expect(pm.agent.updateMany).toHaveBeenCalledWith({ where: { id: AID, version: 1 }, data: { isArchived: true, version: { increment: 1 } } });
  });
});
