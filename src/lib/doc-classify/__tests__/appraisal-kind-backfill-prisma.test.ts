/**
 * 本番の DB 向けの部品(prismaKindBackfillDeps)。物件をロックしてから読み直し、まだ「その他」のときだけ書く。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { tx, db, lock, audit } = vi.hoisted(() => {
  const tx = {
    attachment: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    property: { findUnique: vi.fn() },
  };
  return {
    tx,
    db: { attachment: { findMany: vi.fn() }, $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) },
    lock: vi.fn(),
    audit: vi.fn(),
  };
});
vi.mock("@/lib/prisma", () => ({ default: db }));
vi.mock("@/lib/property-record-guard", () => ({ lockPropertyRow: lock }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: audit }));

import { prismaKindBackfillDeps } from "../appraisal-kind-backfill";

const WHERE = { targetType: "property", isDeleted: false, type: "general", docKind: null };

beforeEach(() => {
  vi.clearAllMocks();
  tx.attachment.findFirst.mockResolvedValue({ fileName: "査定書.pdf", docTitle: null, createdAt: new Date("2026-09-01T00:00:00Z") });
  tx.attachment.findMany.mockResolvedValue([]);
  tx.attachment.updateMany.mockResolvedValue({ count: 1 });
  tx.property.findUnique.mockResolvedValue({ buildingName: null, roomNo: null, address: "東京都架空区見本町4-5-6" });
});

describe("prismaKindBackfillDeps", () => {
  it("対象は物件の一般の書類・削除されていない・種類なし", async () => {
    const d = await prismaKindBackfillDeps();
    db.attachment.findMany.mockResolvedValue([]);
    await d.listUnclassified();
    expect(db.attachment.findMany.mock.calls[0][0].where).toEqual(WHERE);
  });
  it("物件をロックしてから読み直し、まだ種類なしの条件のまま書く(段階・種類・名前・manual)", async () => {
    const d = await prismaKindBackfillDeps();
    expect(await d.setKind({ id: "a1", targetId: "p1" })).toBe(true);
    expect(lock).toHaveBeenCalledWith(tx, "p1");
    expect(lock.mock.invocationCallOrder[0]).toBeLessThan(tx.attachment.findFirst.mock.invocationCallOrder[0]);
    expect(tx.attachment.findFirst.mock.calls[0][0].where).toEqual({ id: "a1", targetId: "p1", ...WHERE });
    const u = tx.attachment.updateMany.mock.calls[0][0];
    expect(u.where).toEqual({ id: "a1", ...WHERE });
    expect(u.data).toMatchObject({ docKind: "appraisal_report", docStage: "pre_contract", docConfidence: "manual" });
    expect(u.data.docTitle).toMatch(/^査定書・査定報告書_/);
  });
  it("読み直したらもう種類が付いていた・消えていた → 書かない", async () => {
    tx.attachment.findFirst.mockResolvedValue(null);
    const d = await prismaKindBackfillDeps();
    expect(await d.setKind({ id: "a1", targetId: "p1" })).toBe(false);
    expect(tx.attachment.updateMany).not.toHaveBeenCalled();
  });
  it("記録は種類の code と物件 ID だけ(ファイル名は残さない)", async () => {
    const d = await prismaKindBackfillDeps();
    await d.audit({ id: "a1", targetId: "p1" });
    expect(audit).toHaveBeenCalledWith({
      userId: null,
      action: "update",
      targetTable: "attachments",
      targetId: "a1",
      detail: { propertyId: "p1", docKind: "appraisal_report", via: "kind_backfill_script" },
    });
  });
});
