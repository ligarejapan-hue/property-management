import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

const { deleteSpy } = vi.hoisted(() => ({ deleteSpy: vi.fn() }));
vi.mock("@/lib/storage", () => ({ getStorage: () => ({ delete: deleteSpy }) }));
vi.mock("@/lib/prisma", () => ({
  default: { attachment: { findMany: vi.fn(), deleteMany: vi.fn() } },
}));
// escapePrismaLikePattern is pure & tested elsewhere; mock as identity to avoid pulling its deps.
vi.mock("@/lib/uploads-authorization", () => ({
  escapePrismaLikePattern: (s: string) => s,
}));

import prisma from "@/lib/prisma";
import {
  purgeableCutoff,
  findPurgeableAttachments,
  purgeExpiredAttachments,
  ATTACHMENT_RETENTION_DAYS,
} from "../attachment-cleanup";

const pm = prisma as unknown as {
  attachment: { findMany: Mock; deleteMany: Mock };
};
const NOW = new Date("2026-06-20T00:00:00Z");

// findMany is called for BOTH the purgeable query and the shared-key check.
// Route by the where shape: fileUrl.contains => shared-key check.
function wireFindMany(purgeable: unknown[], sharedRefs: unknown[] = []) {
  pm.attachment.findMany.mockImplementation((args: { where?: { fileUrl?: { contains?: string } } }) => {
    if (args?.where?.fileUrl?.contains !== undefined) {
      return Promise.resolve(sharedRefs);
    }
    return Promise.resolve(purgeable);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  deleteSpy.mockResolvedValue(undefined);
  pm.attachment.deleteMany.mockResolvedValue({ count: 1 });
  wireFindMany([]);
});

describe("purgeableCutoff", () => {
  it("now から retentionDays 日前を返す", () => {
    expect(ATTACHMENT_RETENTION_DAYS).toBe(90);
    const c = purgeableCutoff(NOW);
    expect(NOW.getTime() - c.getTime()).toBe(90 * 24 * 60 * 60 * 1000);
  });
});

describe("findPurgeableAttachments", () => {
  it("isDeleted=true / type≠registry / deletedAt<=cutoff / 件数上限 を where に反映", async () => {
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
    wireFindMany([{ id: "a1", fileUrl: "/uploads/properties/p/attachments/1.pdf" }]);
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200, dryRun: true });
    expect(r).toEqual({ scanned: 1, purged: 0 });
    expect(pm.attachment.deleteMany).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("自前 storage key・他参照なし → 条件付き deleteMany + 実体削除", async () => {
    wireFindMany([{ id: "a1", fileUrl: "/uploads/properties/p/attachments/1.pdf" }], []);
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    const delArg = pm.attachment.deleteMany.mock.calls[0][0];
    expect(delArg.where).toMatchObject({ id: "a1", isDeleted: true, type: { not: "registry" } });
    expect(delArg.where.deletedAt.not).toBe(null);
    expect(delArg.where.deletedAt.lte).toBeInstanceOf(Date);
    expect(deleteSpy).toHaveBeenCalledWith("properties/p/attachments/1.pdf");
    expect(r).toEqual({ scanned: 1, purged: 1 });
  });

  it("外部URL/不正URL は storage を消さず行のみ削除（誤爆防止）", async () => {
    wireFindMany([{ id: "a2", fileUrl: "https://evil.example/uploads/x.pdf" }]);
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    expect(pm.attachment.deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(r.purged).toBe(1);
  });

  it("選択後に復元/並行purge（deleteMany count=0）→ スキップ・storage不変", async () => {
    wireFindMany([{ id: "a3", fileUrl: "/uploads/properties/p/attachments/3.pdf" }]);
    pm.attachment.deleteMany.mockResolvedValueOnce({ count: 0 });
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(r).toEqual({ scanned: 1, purged: 0 });
  });

  it("他の添付行が同一 key を参照 → 行は purge するが storage は消さない（共有object保護）", async () => {
    wireFindMany(
      [{ id: "a4", fileUrl: "/uploads/properties/p/attachments/4.pdf" }],
      [{ fileUrl: "/uploads/properties/p/attachments/4.pdf" }], // another row references same key
    );
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    expect(pm.attachment.deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(r.purged).toBe(1);
  });

  it("storage.delete が失敗してもバッチは止まらず残りを処理", async () => {
    wireFindMany([
      { id: "b1", fileUrl: "/uploads/properties/p/attachments/b1.pdf" },
      { id: "b2", fileUrl: "/uploads/properties/p/attachments/b2.pdf" },
    ]);
    deleteSpy.mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    expect(pm.attachment.deleteMany).toHaveBeenCalledTimes(2);
    expect(deleteSpy).toHaveBeenCalledTimes(2);
    expect(r).toEqual({ scanned: 2, purged: 2 });
  });
});
