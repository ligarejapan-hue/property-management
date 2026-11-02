import { beforeEach, describe, expect, it, vi } from "vitest";

const writeAuditLog = vi.hoisted(() => vi.fn(async () => undefined));
const pm = vi.hoisted(() => {
  const fn = () => vi.fn<(args?: unknown) => Promise<unknown>>(async () => null);
  const model = () => ({ findMany: fn(), findUnique: fn(), findFirst: fn(), count: fn() });
  return {
    property: model(), deal: model(), comment: model(), ownerMemo: model(), propertyOwner: model(), propertyDmLog: model(), agentInquiry: model(),
    agentViewing: model(), agentInquiryMaterialSend: model(), nextAction: model(), propertyInvestigationAuditLog: model(), changeLog: model(),
    dealScheduleItem: model(), dealDocument: model(), auditLog: model(), dealDocFile: model(), dealDocRequest: model(), dealDocLink: model(), user: model(),
  };
});

vi.mock("next/server", async () => (await import("@/lib/__tests__/agent-inquiry-route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("@/lib/__tests__/agent-inquiry-route-mocks")).apiHelpersMock());
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
vi.mock("@/lib/deals/settings-store", () => ({ loadDealSettings: vi.fn(async () => ({ requestTemplates: [] })) }));
vi.mock("@/lib/prisma", () => ({ default: pm }));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { GET as propertyGET } from "@/app/api/properties/[id]/timeline/route";
import { GET as dealGET } from "@/app/api/deals/[id]/timeline/route";

const PID = "22222222-2222-4222-8222-222222222222";
const DID = "11111111-1111-4111-8111-111111111111";
const perm = (resource: string, action: string) => ({ resource, action, granted: true });
type Fn = ReturnType<typeof vi.fn>;

const propCtx = { params: Promise.resolve({ id: PID }) };
const dealCtx = { params: Promise.resolve({ id: DID }) };
const req = (path: string) => new Request(`http://x${path}`) as never;
const propertyRow = { id: PID, createdBy: "x", assignedTo: "y", buildingId: null, caseStatus: "on_sale" };
const dealRow = { id: DID, dealNo: "2026-0001", status: "considering", createdAt: new Date("2026-09-01T00:00:00Z"), createdBy: { name: "担当A" }, propertyId: PID };

const memoRow = { id: "m1", body: "所有者の事情", createdAt: new Date("2026-10-01T00:00:00Z"), creator: { name: "担当A" } };
const dmRow = { id: "d1", sentAt: new Date("2026-10-02T00:00:00Z"), method: "mail", note: "DMの備考", sender: { name: "担当A" } };
const commentRow = { id: "c1", body: "コメント本文", createdAt: new Date("2026-10-03T00:00:00Z"), author: { name: "担当A" }, parentId: null };

const models = () => Object.values(pm) as Array<Record<string, Fn>>;
const setPerms = (session: { id: string; role: string }, perms: unknown[]) => {
  (getApiSession as Fn).mockResolvedValue(session);
  (getUserPermissions as Fn).mockResolvedValue(perms);
};
const OFFICE = { id: "u1", role: "office_staff" };
const ALL_PERMS = ["property", "owner", "deal", "agent_inquiry"].map((r) => perm(r, "read")).concat(perm("owner_note", "full"), perm("owner_name", "full"));

beforeEach(() => {
  vi.clearAllMocks();
  for (const m of models()) {
    m.findMany.mockResolvedValue([]);
    m.findUnique.mockResolvedValue(null);
    m.findFirst.mockResolvedValue(null);
    m.count.mockResolvedValue(0);
  }
  pm.property.findUnique.mockResolvedValue(propertyRow);
  pm.deal.findUnique.mockResolvedValue(dealRow);
  pm.comment.findMany.mockResolvedValue([commentRow]);
  pm.ownerMemo.findMany.mockResolvedValue([memoRow]);
  pm.propertyDmLog.findMany.mockImplementation((async (args: { where: Record<string, unknown> }) => (args.where.reactedAt ? [] : [dmRow])) as never);
  setPerms(OFFICE, ALL_PERMS);
});

describe("物件の経緯", () => {
  it("権限があれば新しい順に並ぶ", async () => {
    const res = await propertyGET(req(`/api/properties/${PID}/timeline`), propCtx);
    expect(res.status).toBe(200);
    const body = await res.json();
    const times = body.events.map((e: { at: string }) => e.at);
    expect(times).toEqual([...times].sort().reverse());
    expect(body.events.map((e: { source: string }) => e.source)).toEqual(expect.arrayContaining(["comment", "owner_memo", "dm"]));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("property:read が無いと 403 で何も読まない", async () => {
    setPerms(OFFICE, [perm("owner", "read")]);
    const res = await propertyGET(req(`/api/properties/${PID}/timeline`), propCtx);
    expect(res.status).toBe(403);
    expect(pm.comment.findMany).not.toHaveBeenCalled();
    expect(pm.ownerMemo.findMany).not.toHaveBeenCalled();
  });

  it("担当外の現地担当は 403 で何も読まない", async () => {
    setPerms({ id: "u1", role: "field_staff" }, ALL_PERMS);
    const res = await propertyGET(req(`/api/properties/${PID}/timeline`), propCtx);
    expect(res.status).toBe(403);
    expect(pm.comment.findMany).not.toHaveBeenCalled();
  });

  it("owner:read が無ければ所有者メモと DM を読まず、本文も件数も出ない", async () => {
    setPerms(OFFICE, [perm("property", "read")]);
    const res = await propertyGET(req(`/api/properties/${PID}/timeline`), propCtx);
    const text = await res.text();
    expect(pm.ownerMemo.findMany).not.toHaveBeenCalled();
    expect(pm.propertyDmLog.findMany).not.toHaveBeenCalled();
    expect(text).not.toContain("所有者の事情");
    expect(text).not.toContain("DMの備考");
    expect(text).toContain("コメント本文");
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("deal:read が無ければ取引の出どころを読まない", async () => {
    setPerms(OFFICE, [perm("property", "read")]);
    await propertyGET(req(`/api/properties/${PID}/timeline`), propCtx);
    expect(pm.deal.findMany).not.toHaveBeenCalled();
    expect(pm.dealDocument.findMany).not.toHaveBeenCalled();
    expect(pm.dealDocRequest.count).not.toHaveBeenCalled();
  });

  it("要約の最後のやり取りは見える行だけから作る", async () => {
    pm.ownerMemo.findMany.mockResolvedValue([{ ...memoRow, createdAt: new Date("2026-10-30T00:00:00Z") }]);
    setPerms(OFFICE, [perm("property", "read")]);
    const body = await (await propertyGET(req(`/api/properties/${PID}/timeline`), propCtx)).json();
    expect(body.summary.lastContactAt).toBe(commentRow.createdAt.toISOString());
    expect(body.summary.pendingDocs).toBeNull();
  });

  it("所有者メモはこの物件と物件指定なしだけを読む", async () => {
    pm.propertyOwner.findMany.mockResolvedValue([{ id: "po1", ownerId: "o1" }]);
    await propertyGET(req(`/api/properties/${PID}/timeline`), propCtx);
    const where = (pm.ownerMemo.findMany.mock.calls[0][0] as { where: unknown }).where;
    expect(JSON.stringify(where)).toContain(`"propertyId":"${PID}"`);
    expect(JSON.stringify(where)).toContain('"ownerId":{"in":["o1"]},"propertyId":null');
  });

  it("所有者の情報を含むときだけ、件数を監査に残す(本文は残さない)", async () => {
    await propertyGET(req(`/api/properties/${PID}/timeline`), propCtx);
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    const arg = (writeAuditLog.mock.calls as unknown as Array<[Record<string, unknown>]>)[0][0];
    expect(arg).toMatchObject({ action: "history_timeline_view", targetTable: "properties", targetId: PID, detail: { count: 2 } });
    expect(JSON.stringify(arg)).not.toContain("所有者の事情");
  });

  it("種類で絞ると、その種類の出どころだけを読む", async () => {
    const res = await propertyGET(req(`/api/properties/${PID}/timeline?category=document`), propCtx);
    const body = await res.json();
    expect(pm.comment.findMany.mock.calls.filter((c) => (c[0] as { take: number }).take > 2)).toHaveLength(0);
    expect(body.events.every((e: { category: string }) => e.category === "document")).toBe(true);
  });

  it("続きの読み込みでは要約を作らない", async () => {
    const before = "2026-10-03T00:00:00.000Z";
    const body = await (await propertyGET(req(`/api/properties/${PID}/timeline?before=${encodeURIComponent(before)}`), propCtx)).json();
    expect(body.summary).toBeNull();
    const where = (pm.comment.findMany.mock.calls[0][0] as { where: { createdAt: { lt: Date } } }).where;
    expect(where.createdAt.lt.toISOString()).toBe(before);
  });

  it("開始点が日時でなければ受け付けない", async () => {
    const res = await propertyGET(req(`/api/properties/${PID}/timeline?before=abc`), propCtx);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(pm.comment.findMany).not.toHaveBeenCalled();
  });
});

describe("読む上限の境目", () => {
  const T = new Date("2026-10-20T00:00:00Z");
  const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, dealId: DID, label: `項目${i}`, completedAt: T, autoCompleted: false }));

  it("同じ時刻に上限を超える行があっても、読み落とさない", async () => {
    // 導入前の項目をまとめて完了にすると、同じ時刻の行が並ぶ。
    pm.dealScheduleItem.findMany.mockImplementation((async (args: { where: { completedAt: { equals?: Date } }; take: number }) =>
      (args.where.completedAt.equals ? items(60) : items(60).slice(0, args.take))) as never);
    const body = await (await dealGET(req(`/api/deals/${DID}/timeline?category=schedule`), dealCtx)).json();
    expect(body.events.filter((e: { source: string }) => e.source === "schedule")).toHaveLength(60);
    expect(body.nextBefore).toBeNull();
  });

  it("上限に届かなければ境目を読み直さない", async () => {
    pm.dealScheduleItem.findMany.mockResolvedValue(items(1));
    await dealGET(req(`/api/deals/${DID}/timeline?category=schedule`), dealCtx);
    expect(pm.dealScheduleItem.findMany).toHaveBeenCalledTimes(1);
  });

  it("提出用リンクの無効化は、発行の順に関係なく無効にした時刻で読む", async () => {
    const link = { id: "l1", dealId: DID, partyRole: "seller", createdAt: new Date("2026-01-01T00:00:00Z"), revokedAt: new Date("2026-10-21T00:00:00Z"), createdBy: { name: "担当A" } };
    pm.dealDocLink.findMany.mockImplementation((async (args: { where: Record<string, unknown> }) => (args.where.revokedAt ? [link] : [])) as never);
    const body = await (await dealGET(req(`/api/deals/${DID}/timeline?category=document`), dealCtx)).json();
    expect(body.events.map((e: { title: string }) => e.title)).toContain("売主の提出用リンクを無効化");
  });

  it("内見は予定日のある分と無い分を別々に日時順で読む", async () => {
    pm.agentViewing.findMany.mockImplementation((async (args: { where: { scheduledAt?: unknown } }) => (args.where.scheduledAt === null ? [] : [{
      id: "v1", scheduledAt: new Date("2026-10-22T00:00:00Z"), createdAt: new Date("2026-01-01T00:00:00Z"), canceledAt: null, resultNote: null, attendant: null,
      inquiry: { agent: { companyName: "ABC" } },
    }])) as never);
    const body = await (await propertyGET(req(`/api/properties/${PID}/timeline?category=contact`), propCtx)).json();
    expect(body.events.map((e: { id: string }) => e.id)).toContain("viewing:v1");
    expect(pm.agentViewing.findMany.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("取引の経緯", () => {
  it("物件の経緯も含み、同じ物件の別の取引は読まない", async () => {
    const res = await dealGET(req(`/api/deals/${DID}/timeline`), dealCtx);
    const body = await res.json();
    expect(body.events.map((e: { source: string }) => e.source)).toEqual(expect.arrayContaining(["comment", "deal_created"]));
    expect(pm.deal.findMany).not.toHaveBeenCalled();
    const docWhere = (pm.dealDocument.findMany.mock.calls[0][0] as { where: { dealId: { in: string[] } } }).where;
    expect(docWhere.dealId.in).toEqual([DID]);
  });

  it("deal:read が無いと 403", async () => {
    setPerms(OFFICE, [perm("property", "read")]);
    const res = await dealGET(req(`/api/deals/${DID}/timeline`), dealCtx);
    expect(res.status).toBe(403);
    expect(pm.dealDocument.findMany).not.toHaveBeenCalled();
  });

  it("物件を見られない人には取引の行だけを出し、隠れていることも分からない", async () => {
    setPerms({ id: "u1", role: "field_staff" }, ALL_PERMS);
    const res = await dealGET(req(`/api/deals/${DID}/timeline`), dealCtx);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(pm.comment.findMany).not.toHaveBeenCalled();
    expect(pm.ownerMemo.findMany).not.toHaveBeenCalled();
    expect(pm.propertyDmLog.findMany).not.toHaveBeenCalled();
    expect(text).not.toContain("コメント本文");
    expect(text).not.toContain("案件ステータス");
    expect(text).toContain("取引を作成");
  });

  it("物件のない取引でも開ける", async () => {
    pm.deal.findUnique.mockResolvedValue({ ...dealRow, propertyId: null });
    const res = await dealGET(req(`/api/deals/${DID}/timeline`), dealCtx);
    expect(res.status).toBe(200);
    expect(pm.property.findUnique).not.toHaveBeenCalled();
    expect(pm.comment.findMany).not.toHaveBeenCalled();
  });

  it("未受領の書類は無効にしたリンクと受領済みを除いて数える", async () => {
    pm.dealDocRequest.count.mockResolvedValue(2);
    const body = await (await dealGET(req(`/api/deals/${DID}/timeline`), dealCtx)).json();
    expect(body.summary.pendingDocs).toBe(2);
    const where = (pm.dealDocRequest.count.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(JSON.stringify(where)).toContain('"revokedAt":null');
    expect(JSON.stringify(where)).toContain('"not":"received"');
  });

  it("中止の取引の書類は未受領に数えず、次の段取りも出さない", async () => {
    pm.deal.findUnique.mockResolvedValue({ ...dealRow, status: "cancelled", propertyId: null });
    const body = await (await dealGET(req(`/api/deals/${DID}/timeline`), dealCtx)).json();
    expect(body.summary.pendingDocs).toBe(0);
    expect(pm.dealDocRequest.count).not.toHaveBeenCalled();
    expect(pm.dealScheduleItem.findFirst).not.toHaveBeenCalled();
    expect(body.summary.next).toBeNull();
  });
});
