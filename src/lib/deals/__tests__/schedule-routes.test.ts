import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", async () => (await import("./route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./route-mocks")).apiHelpersMock());
const { writeAuditLog, syncDealScheduleSafe, loadScheduleItems, lockCalls, settleDealFromSchedule } = vi.hoisted(() => ({
  writeAuditLog: vi.fn(), syncDealScheduleSafe: vi.fn(async () => undefined), loadScheduleItems: vi.fn(async () => []), lockCalls: [] as string[],
  settleDealFromSchedule: vi.fn(async (): Promise<unknown> => ({ result: "settled", caseStatusNotChanged: false })),
}));
vi.mock("@/lib/deals/settle-from-schedule", () => ({ SETTLE_ITEM_KEY: "s_settle", settleDealFromSchedule }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
vi.mock("@/lib/deals/schedule-sync", () => ({
  syncDealScheduleSafe, loadScheduleItems, scheduleDealTitle: (d: { name: string }) => d.name,
  withDealLock: async (id: string, fn: (tx: unknown) => unknown) => {
    lockCalls.push(id);
    return fn((await import("@/lib/prisma")).default);
  },
}));
vi.mock("@/lib/agent-inquiry/user-check", () => ({ assertActiveUser: vi.fn(async () => undefined) }));
vi.mock("@/lib/prisma", () => ({
  default: {
    deal: { findUnique: vi.fn() },
    dealScheduleItem: { create: vi.fn(), updateMany: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
    dealDocLink: { findMany: vi.fn(async () => []) },
    dealSettings: { findUnique: vi.fn(async () => null) },
    auditLog: { findMany: vi.fn(async () => []) },
  },
}));

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { DEAL_ID, DEAL_PERMS, USER_ID } from "./route-mocks";
import { GET, POST } from "../../../app/api/deals/[id]/schedule/route";
import { PATCH } from "../../../app/api/deals/[id]/schedule/[itemId]/route";
import { POST as COMPLETE_PRE } from "../../../app/api/deals/[id]/schedule/complete-pre/route";
import { GET as MINE } from "../../../app/api/deals/schedule/mine/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as { deal: { findUnique: Fn }; dealScheduleItem: { create: Fn; updateMany: Fn; findMany: Fn; findFirst: Fn } };
const ITEM_ID = "33333333-3333-4333-8333-333333333333";
const ctx = { params: Promise.resolve({ id: DEAL_ID }) };
const itemCtx = { params: Promise.resolve({ id: DEAL_ID, itemId: ITEM_ID }) };
const req = (body: unknown) => new Request("http://x", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  vi.clearAllMocks();
  lockCalls.length = 0;
  (getApiSession as Fn).mockResolvedValue({ id: USER_ID, role: "office_staff" });
  (getUserPermissions as Fn).mockResolvedValue(DEAL_PERMS);
  pm.deal.findUnique.mockResolvedValue({ id: DEAL_ID, settlementAt: new Date("2026-12-16T01:00:00Z") });
  pm.dealScheduleItem.updateMany.mockResolvedValue({ count: 1 });
  pm.dealScheduleItem.create.mockResolvedValue({ id: ITEM_ID });
  pm.dealScheduleItem.findFirst.mockResolvedValue({ templateKey: "c_x", completedAt: null });
});

describe("段取りの API", () => {
  it("権限が無ければ 403", async () => {
    (getUserPermissions as Fn).mockResolvedValue([]);
    expect((await GET(new Request("http://x"), ctx)).status).toBe(403);
    expect((await POST(req({ label: "a", dueDate: "2026-11-20" }), ctx)).status).toBe(403);
    expect((await PATCH(req({ completed: true }), itemCtx)).status).toBe(403);
    expect((await COMPLETE_PRE(new Request("http://x", { method: "POST" }), ctx)).status).toBe(403);
    expect((await MINE()).status).toBe(403);
  });

  it("開いたときに同期してから項目を返す。決済日は日本時間の日付", async () => {
    const res = await GET(new Request("http://x"), ctx);
    expect(res.status).toBe(200);
    expect(syncDealScheduleSafe).toHaveBeenCalledWith(DEAL_ID, expect.objectContaining({ userId: USER_ID }));
    expect((await res.json()).settlementDate).toBe("2026-12-16");
  });

  it("無い取引は 404", async () => {
    pm.deal.findUnique.mockResolvedValue(null);
    expect((await GET(new Request("http://x"), ctx)).status).toBe(404);
  });

  it("手で足す: 期限と担当は手で決めた扱い・担当が無ければ足した人・監査に作業名を載せない", async () => {
    const res = await POST(req({ label: "秘密の作業名", dueDate: "2026-11-20" }), ctx);
    expect(res.status).toBe(201);
    const { data } = pm.dealScheduleItem.create.mock.calls[0][0];
    expect(data).toMatchObject({ dealId: DEAL_ID, label: "秘密の作業名", dueManual: true, assigneeManual: true, assigneeId: USER_ID });
    expect(data.templateKey).toBeUndefined();
    expect(JSON.stringify(writeAuditLog.mock.calls)).not.toContain("秘密の作業名");
  });

  it("手で足す: 空の作業名・無い日付は 422", async () => {
    expect((await POST(req({ label: " ", dueDate: "2026-11-20" }), ctx)).status).toBe(422);
    expect((await POST(req({ label: "a", dueDate: "2026-02-30" }), ctx)).status).toBe(422);
  });

  it("期限を直すと手で直した印が付き、導入前も外れる。取引の鍵を持って書く", async () => {
    await PATCH(req({ dueDate: "2026-11-20" }), itemCtx);
    expect(lockCalls).toEqual([DEAL_ID]);
    const arg = pm.dealScheduleItem.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ id: ITEM_ID, dealId: DEAL_ID });
    expect(arg.data).toMatchObject({ dueDate: new Date("2026-11-20T00:00:00.000Z"), dueManual: true, preIntroduction: false });
  });

  it("担当を直すと手で直した印が付く", async () => {
    const assigneeId = "44444444-4444-4444-8444-444444444444";
    await PATCH(req({ assigneeId }), itemCtx);
    expect(pm.dealScheduleItem.updateMany.mock.calls[0][0].data).toEqual({ assigneeId, assigneeManual: true });
  });

  it("完了と取り消し", async () => {
    await PATCH(req({ completed: true }), itemCtx);
    expect(pm.dealScheduleItem.updateMany.mock.calls[0][0].data.completedAt).toBeInstanceOf(Date);
    await PATCH(req({ completed: false }), itemCtx);
    expect(pm.dealScheduleItem.updateMany.mock.calls[1][0].data).toMatchObject({ completedAt: null, autoCompleted: false });
  });

  it("「決済・引渡し」を完了にしたら取引を決済完了にし、段取りに伝えて監査に残す(11-20 発注者)", async () => {
    pm.dealScheduleItem.findFirst.mockResolvedValue({ templateKey: "s_settle", completedAt: null });
    const res = await PATCH(req({ completed: true }), itemCtx);
    expect(await res.json()).toEqual({ ok: true, dealStatus: "settled" });
    expect(settleDealFromSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: USER_ID }), DEAL_PERMS, DEAL_ID, ITEM_ID);
    // 出来事(settled)は送り直さない(後から取り消した完了を上書きしない)
    expect(syncDealScheduleSafe).toHaveBeenCalledWith(DEAL_ID, { userId: USER_ID });
    expect(writeAuditLog.mock.calls.map((c) => c[0].detail)).toContainEqual({ op: "auto_settle", fields: ["status"], count: 1, itemId: ITEM_ID });
  });

  it("状態を変えられない人なら、変えなかったことを返す・案件ステータスが動かなかったことも返す", async () => {
    pm.dealScheduleItem.findFirst.mockResolvedValue({ templateKey: "s_settle", completedAt: null });
    settleDealFromSchedule.mockResolvedValueOnce({ result: "forbidden" });
    expect(await (await PATCH(req({ completed: true }), itemCtx)).json()).toEqual({ ok: true, dealStatus: "forbidden" });
    expect(syncDealScheduleSafe).not.toHaveBeenCalled();
    settleDealFromSchedule.mockResolvedValueOnce({ result: "settled", caseStatusNotChanged: true });
    expect(await (await PATCH(req({ completed: true }), itemCtx)).json()).toEqual({ ok: true, dealStatus: "settled", caseStatusNotChanged: true });
  });

  it("ほかの項目・取り消し・もう完了していた「決済・引渡し」では状態に触らない", async () => {
    await PATCH(req({ completed: true }), itemCtx);
    pm.dealScheduleItem.findFirst.mockResolvedValue({ templateKey: "s_settle", completedAt: null });
    await PATCH(req({ completed: false }), itemCtx);
    await PATCH(req({ assigneeId: null }), itemCtx);
    pm.dealScheduleItem.findFirst.mockResolvedValue({ templateKey: "s_settle", completedAt: new Date() });
    expect(await (await PATCH(req({ completed: true }), itemCtx)).json()).toEqual({ ok: true });
    expect(settleDealFromSchedule).not.toHaveBeenCalled();
  });

  it("状態を変えるのに失敗しても、完了の保存は成功のまま", async () => {
    pm.dealScheduleItem.findFirst.mockResolvedValue({ templateKey: "s_settle", completedAt: null });
    settleDealFromSchedule.mockRejectedValueOnce(new Error("db"));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await PATCH(req({ completed: true }), itemCtx)).status).toBe(200);
    err.mockRestore();
  });

  it("手で対象外にすると、条件が戻っても戻らない印が付く", async () => {
    await PATCH(req({ excluded: true }), itemCtx);
    expect(pm.dealScheduleItem.updateMany.mock.calls[0][0].data).toMatchObject({ excludedManual: true });
  });

  it("ほかの取引の項目は直せない(404)・空の変更は 422", async () => {
    pm.dealScheduleItem.updateMany.mockResolvedValue({ count: 0 });
    expect((await PATCH(req({ completed: true }), itemCtx)).status).toBe(404);
    expect((await PATCH(req({}), itemCtx)).status).toBe(422);
  });

  it("導入前の項目をまとめて完了にする(未完了で対象外でないものだけ)", async () => {
    pm.dealScheduleItem.updateMany.mockResolvedValue({ count: 4 });
    const res = await COMPLETE_PRE(new Request("http://x", { method: "POST" }), ctx);
    expect((await res.json()).count).toBe(4);
    expect(lockCalls).toEqual([DEAL_ID]);
    expect(pm.dealScheduleItem.updateMany.mock.calls[0][0].where).toEqual({ dealId: DEAL_ID, preIntroduction: true, completedAt: null, excludedAt: null });
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ detail: { op: "complete_pre", count: 4 } }));
  });

  it("自分の段取り: 本人が担当・中止を除く。導入前の過ぎた項目を出さない", async () => {
    pm.dealScheduleItem.findMany.mockResolvedValue([]);
    await MINE();
    const { where } = pm.dealScheduleItem.findMany.mock.calls[0][0];
    expect(where.assigneeId).toBe(USER_ID);
    expect(where.deal).toEqual({ status: { not: "cancelled" } });
    expect(where.OR[0]).toEqual({ preIntroduction: false });
  });
});
