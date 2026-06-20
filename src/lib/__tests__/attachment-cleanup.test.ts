import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

const { deleteSpy } = vi.hoisted(() => ({ deleteSpy: vi.fn() }));
vi.mock("@/lib/storage", () => ({ getStorage: () => ({ delete: deleteSpy }) }));
vi.mock("@/lib/prisma", () => ({ default: { attachment: { findMany: vi.fn(), delete: vi.fn() } } }));

import prisma from "@/lib/prisma";
import { purgeableCutoff, findPurgeableAttachments, purgeExpiredAttachments, ATTACHMENT_RETENTION_DAYS } from "../attachment-cleanup";

const pm = prisma as unknown as { attachment: { findMany: Mock; delete: Mock } };
const NOW = new Date("2026-06-20T00:00:00Z");

beforeEach(() => { vi.clearAllMocks(); deleteSpy.mockResolvedValue(undefined); pm.attachment.delete.mockResolvedValue({}); });

describe("purgeableCutoff", () => {
  it("now から retentionDays 日前を返す", () => {
    expect(ATTACHMENT_RETENTION_DAYS).toBe(90);
    const c = purgeableCutoff(NOW);
    expect(NOW.getTime() - c.getTime()).toBe(90 * 24 * 60 * 60 * 1000);
  });
});

describe("findPurgeableAttachments", () => {
  it("isDeleted=true / type≠registry / deletedAt<=cutoff / 件数上限 を where に反映", async () => {
    pm.attachment.findMany.mockResolvedValue([]);
    await findPurgeableAttachments(NOW, 200);
    const arg = pm.attachment.findMany.mock.calls[0][0];
    expect(arg.where.isDeleted).toBe(true);
    expect(arg.where.type).toEqual({ not: "registry" });
    expect(arg.where.deletedAt.not).toBe(null);
    expect(arg.where.deletedAt.lte).toBeInstanceOf(Date);
    expect(arg.take).toBe(200);
    expect(arg.select).toEqual({ id: true, fileUrl: true });
  });
});

describe("purgeExpiredAttachments", () => {
  it("dryRun は storage/DB を消さず scanned のみ返す", async () => {
    pm.attachment.findMany.mockResolvedValue([{ id: "a1", fileUrl: "/uploads/properties/p/attachments/1.pdf" }]);
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200, dryRun: true });
    expect(r).toEqual({ scanned: 1, purged: 0 });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(pm.attachment.delete).not.toHaveBeenCalled();
  });

  it("自前 storage key は実体削除 + 行削除", async () => {
    pm.attachment.findMany.mockResolvedValue([{ id: "a1", fileUrl: "/uploads/properties/p/attachments/1.pdf" }]);
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    expect(deleteSpy).toHaveBeenCalledWith("properties/p/attachments/1.pdf");
    expect(pm.attachment.delete).toHaveBeenCalledWith({ where: { id: "a1" } });
    expect(r).toEqual({ scanned: 1, purged: 1 });
  });

  it("外部URL/不正URL は storage を消さず行のみ削除（誤爆防止）", async () => {
    pm.attachment.findMany.mockResolvedValue([{ id: "a2", fileUrl: "https://evil.example/uploads/x.pdf" }]);
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(pm.attachment.delete).toHaveBeenCalledWith({ where: { id: "a2" } });
    expect(r.purged).toBe(1);
  });
});
