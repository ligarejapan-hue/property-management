import { describe, expect, it, vi, beforeEach } from "vitest";

const { lockPropertyRow, syncCaseStatusFromDeals, caseStatusWouldMove, syncDealDocRetention } = vi.hoisted(() => ({
  lockPropertyRow: vi.fn(async () => undefined),
  syncCaseStatusFromDeals: vi.fn(async () => undefined),
  caseStatusWouldMove: vi.fn(async () => true),
  syncDealDocRetention: vi.fn(async () => undefined),
}));
vi.mock("@/lib/prisma", () => ({ default: {} }));
vi.mock("@/lib/property-record-guard", () => ({ lockPropertyRow }));
vi.mock("../status-link", async (orig) => ({ ...(await orig<typeof import("../status-link")>()), syncCaseStatusFromDeals, caseStatusWouldMove, syncDealDocRetention }));

import { settleDealFromSchedule, settleDecision } from "../settle-from-schedule";
import type { PermissionMap } from "@/lib/permissions";

const ADMIN = { id: "u-admin", role: "admin" };
const STAFF = { id: "u-staff", role: "office_staff" };
const PROP_WRITE: PermissionMap = [{ resource: "property", action: "write", granted: true }, { resource: "deal", action: "write", granted: true }];
const DEAL_ONLY: PermissionMap = [{ resource: "deal", action: "write", granted: true }];

function fakeDb(deal: { status: string; assigneeId: string | null; propertyId: string | null; version?: number } | null, property = { createdBy: "u-other", assignedTo: null as string | null }) {
  const tx = {
    deal: {
      findUnique: vi.fn(async () => (deal ? { version: 7, ...deal } : null)),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    property: { findUnique: vi.fn(async () => property) },
    changeLog: { create: vi.fn(async (_args: { data: Record<string, unknown> }) => ({})) },
  };
  const db = { $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)) };
  return { tx, db: db as never };
}

beforeEach(() => vi.clearAllMocks());

describe("「決済・引渡し」の完了で取引を決済完了に(2026-11-20 発注者)", () => {
  it("判定: 管理者・取引の担当者・物件の担当者なら変える。中止ともう決済完了は動かさない", () => {
    expect(settleDecision(ADMIN, { status: "contracted", assigneeId: null }, null)).toBe("settle");
    expect(settleDecision(STAFF, { status: "contracted", assigneeId: STAFF.id }, null)).toBe("settle");
    expect(settleDecision(STAFF, { status: "considering", assigneeId: null }, { assignedTo: STAFF.id })).toBe("settle");
    expect(settleDecision(STAFF, { status: "contracted", assigneeId: "u-other" }, { assignedTo: null })).toBe("forbidden");
    expect(settleDecision(ADMIN, { status: "cancelled", assigneeId: null }, null)).toBe("cancelled");
    expect(settleDecision(ADMIN, { status: "settled", assigneeId: null }, null)).toBe("already");
  });

  it("変える: 物件の行を先に押さえ、取引を決済完了に・変更履歴(自動)・物件を編集できれば案件ステータスもそろえる", async () => {
    const { tx, db } = fakeDb({ status: "contracted", assigneeId: null, propertyId: "p1" });
    const out = await settleDealFromSchedule(ADMIN, PROP_WRITE, "d1", db);
    expect(out).toEqual({ result: "settled", caseStatusNotChanged: false });
    expect(lockPropertyRow).toHaveBeenCalledWith(tx, "p1");
    expect(lockPropertyRow.mock.invocationCallOrder[0]).toBeLessThan(tx.deal.updateMany.mock.invocationCallOrder[0]);
    expect(tx.deal.updateMany).toHaveBeenCalledWith({ where: { id: "d1", status: "contracted", version: 7 }, data: { status: "settled", version: { increment: 1 } } });
    expect(tx.changeLog.create.mock.calls[0][0].data).toMatchObject({ targetTable: "deals", targetId: "d1", fieldName: "status", oldValue: "contracted", newValue: "settled", source: "auto", changedBy: ADMIN.id });
    expect(syncDealDocRetention).toHaveBeenCalledWith(tx, "d1", "contracted", "settled");
    expect(syncCaseStatusFromDeals).toHaveBeenCalledWith(tx, { propertyId: "p1", changedBy: ADMIN.id });
  });

  it("物件を編集できない人なら案件ステータスは動かさず、動くはずだったことを返す", async () => {
    const { db } = fakeDb({ status: "contracted", assigneeId: STAFF.id, propertyId: "p1" });
    const out = await settleDealFromSchedule(STAFF, DEAL_ONLY, "d1", db);
    expect(out).toEqual({ result: "settled", caseStatusNotChanged: true });
    expect(syncCaseStatusFromDeals).not.toHaveBeenCalled();
  });

  it("状態を変えられない人・中止の取引なら何も書かない", async () => {
    for (const [session, deal, want] of [
      [STAFF, { status: "contracted", assigneeId: "u-other", propertyId: null }, "forbidden"],
      [ADMIN, { status: "cancelled", assigneeId: null, propertyId: null }, "cancelled"],
    ] as const) {
      const { tx, db } = fakeDb({ ...deal });
      expect(await settleDealFromSchedule(session, PROP_WRITE, "d1", db)).toEqual({ result: want });
      expect(tx.deal.updateMany).not.toHaveBeenCalled();
      expect(tx.changeLog.create).not.toHaveBeenCalled();
    }
  });

  it("権限を見た版のあとで取引が変わっていたら(担当者の付け替えなど)書かずに conflict(@codex #766 P2)", async () => {
    const { tx, db } = fakeDb({ status: "contracted", assigneeId: STAFF.id, propertyId: null });
    tx.deal.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await settleDealFromSchedule(STAFF, PROP_WRITE, "d1", db)).toEqual({ result: "conflict" });
    expect(tx.changeLog.create).not.toHaveBeenCalled();
  });

  it("物件の無い取引は案件ステータスに触らない", async () => {
    const { tx, db } = fakeDb({ status: "considering", assigneeId: null, propertyId: null });
    expect(await settleDealFromSchedule(ADMIN, PROP_WRITE, "d1", db)).toEqual({ result: "settled", caseStatusNotChanged: false });
    expect(lockPropertyRow).not.toHaveBeenCalled();
    expect(tx.property.findUnique).not.toHaveBeenCalled();
    expect(syncCaseStatusFromDeals).not.toHaveBeenCalled();
  });
});
