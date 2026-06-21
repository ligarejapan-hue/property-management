import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

const { deleteSpy } = vi.hoisted(() => ({ deleteSpy: vi.fn() }));
vi.mock("@/lib/storage", () => ({ getStorage: () => ({ delete: deleteSpy }) }));
vi.mock("@/lib/prisma", () => ({
  default: {
    attachment: { findMany: vi.fn(), deleteMany: vi.fn(), findUnique: vi.fn() },
    propertyPhoto: { findMany: vi.fn() },
    buildingPhoto: { findMany: vi.fn() },
    fieldSurveyPinPhoto: { findMany: vi.fn() },
  },
}));
// escapePrismaLikePattern is pure & tested elsewhere; mock as identity to avoid pulling its deps.
// extractStorageKeyFromFileUrl: legacy-aware — handles relative /uploads/ and absolute http(s)://host/uploads/.
vi.mock("@/lib/uploads-authorization", () => ({
  escapePrismaLikePattern: (s: string) => s,
  extractStorageKeyFromFileUrl: (u: string | null | undefined) => {
    if (typeof u !== "string") return null;
    const i = u.indexOf("/uploads/");
    if (i === -1) return null;
    return u.slice(i + "/uploads/".length).split(/[?#]/)[0] || null;
  },
}));

import prisma from "@/lib/prisma";
import {
  purgeableCutoff,
  findPurgeableAttachments,
  purgeExpiredAttachments,
  ATTACHMENT_RETENTION_DAYS,
} from "../attachment-cleanup";

const pm = prisma as unknown as {
  attachment: { findMany: Mock; deleteMany: Mock; findUnique: Mock };
  propertyPhoto: { findMany: Mock };
  buildingPhoto: { findMany: Mock };
  fieldSurveyPinPhoto: { findMany: Mock };
};
const NOW = new Date("2026-06-20T00:00:00Z");
const CUTOFF = new Date(NOW.getTime() - 90 * 24 * 60 * 60 * 1000);

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

/** Default valid re-verify response (eligible for purge). */
function validCurrent(overrides: Partial<{
  isDeleted: boolean;
  type: string;
  deletedAt: Date | null;
  fileUrl: string;
}> = {}) {
  return {
    isDeleted: true,
    type: "document",
    deletedAt: CUTOFF,
    fileUrl: "/uploads/properties/p/attachments/1.pdf",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  deleteSpy.mockResolvedValue(undefined);
  pm.attachment.deleteMany.mockResolvedValue({ count: 1 });
  pm.attachment.findUnique.mockResolvedValue(validCurrent());
  pm.propertyPhoto.findMany.mockResolvedValue([]);
  pm.buildingPhoto.findMany.mockResolvedValue([]);
  pm.fieldSurveyPinPhoto.findMany.mockResolvedValue([]);
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
  // ─── 1. dryRun ──────────────────────────────────────────────────────────
  it("dryRun は storage/DB を消さず scanned のみ返す", async () => {
    wireFindMany([{ id: "a1", fileUrl: "/uploads/properties/p/attachments/1.pdf" }]);
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200, dryRun: true });
    expect(r).toEqual({ scanned: 1, purged: 0, failed: 0, skipped: 0 });
    expect(pm.attachment.deleteMany).not.toHaveBeenCalled();
    expect(pm.attachment.findUnique).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  // ─── 2. storage delete SUCCESS → DB row deleted, purged:1, failed:0 ────
  it("自前 storage key・他参照なし → storage 削除後に deleteMany、purged:1 failed:0", async () => {
    wireFindMany([{ id: "a1", fileUrl: "/uploads/properties/p/attachments/1.pdf" }], []);
    pm.attachment.findUnique.mockResolvedValue(validCurrent({ fileUrl: "/uploads/properties/p/attachments/1.pdf" }));
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    // storage deleted first
    expect(deleteSpy).toHaveBeenCalledWith("properties/p/attachments/1.pdf");
    // then DB row deleted
    const delArg = pm.attachment.deleteMany.mock.calls[0][0];
    expect(delArg.where).toMatchObject({ id: "a1", isDeleted: true, type: { not: "registry" } });
    expect(delArg.where.deletedAt.not).toBe(null);
    expect(delArg.where.deletedAt.lte).toBeInstanceOf(Date);
    expect(r).toEqual({ scanned: 1, purged: 1, failed: 0, skipped: 0 });
  });

  // ─── 3. storage delete FAILURE → DB row NOT deleted, failed:1, purged:0 ─
  it("storage.delete 失敗 → deleteMany を呼ばず DB 行保持、failed:1 purged:0（次回再試行）", async () => {
    wireFindMany([{ id: "a1", fileUrl: "/uploads/properties/p/attachments/1.pdf" }], []);
    pm.attachment.findUnique.mockResolvedValue(validCurrent({ fileUrl: "/uploads/properties/p/attachments/1.pdf" }));
    deleteSpy.mockRejectedValueOnce(new Error("boom"));
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    // storage was attempted
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    // DB row NOT deleted (row kept for retry)
    expect(pm.attachment.deleteMany).not.toHaveBeenCalled();
    expect(r).toEqual({ scanned: 1, purged: 0, failed: 1, skipped: 0 });
  });

  // ─── 4. failure NOT counted as purged (same as #3, explicit assertion) ──
  it("storage 失敗は purged にカウントされない・success として握りつぶさない", async () => {
    wireFindMany([
      { id: "b1", fileUrl: "/uploads/properties/p/attachments/b1.pdf" },
      { id: "b2", fileUrl: "/uploads/properties/p/attachments/b2.pdf" },
    ]);
    pm.attachment.findUnique
      .mockResolvedValueOnce(validCurrent({ fileUrl: "/uploads/properties/p/attachments/b1.pdf" }))
      .mockResolvedValueOnce(validCurrent({ fileUrl: "/uploads/properties/p/attachments/b2.pdf" }));
    deleteSpy.mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    // b1 failed, b2 succeeded
    expect(r.failed).toBe(1);
    expect(r.purged).toBe(1);
    expect(r.failed + r.purged).toBe(2); // total = scanned
    // b1 row kept (deleteMany called only once, for b2)
    expect(pm.attachment.deleteMany).toHaveBeenCalledTimes(1);
    expect(pm.attachment.deleteMany.mock.calls[0][0].where.id).toBe("b2");
  });

  // ─── 5. registry re-verify → skipped ──────────────────────────────────
  it("re-verify で type=registry → skipped（storage/deleteMany 不呼）", async () => {
    wireFindMany([{ id: "r1", fileUrl: "/uploads/properties/p/attachments/reg.pdf" }]);
    pm.attachment.findUnique.mockResolvedValue(validCurrent({ type: "registry", fileUrl: "/uploads/properties/p/attachments/reg.pdf" }));
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(pm.attachment.deleteMany).not.toHaveBeenCalled();
    expect(r).toEqual({ scanned: 1, purged: 0, failed: 0, skipped: 1 });
  });

  // ─── 6. not soft-deleted re-verify → skipped ──────────────────────────
  it("re-verify で isDeleted=false → skipped（復元ガード）", async () => {
    wireFindMany([{ id: "s1", fileUrl: "/uploads/properties/p/attachments/s1.pdf" }]);
    pm.attachment.findUnique.mockResolvedValue(validCurrent({ isDeleted: false }));
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(pm.attachment.deleteMany).not.toHaveBeenCalled();
    expect(r).toEqual({ scanned: 1, purged: 0, failed: 0, skipped: 1 });
  });

  it("re-verify で deletedAt > cutoff → skipped（猶予未超過）", async () => {
    wireFindMany([{ id: "s2", fileUrl: "/uploads/properties/p/attachments/s2.pdf" }]);
    const futureDate = new Date(NOW.getTime() - 1000); // 1 second before NOW, so > cutoff
    pm.attachment.findUnique.mockResolvedValue(validCurrent({ deletedAt: futureDate }));
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(pm.attachment.deleteMany).not.toHaveBeenCalled();
    expect(r).toEqual({ scanned: 1, purged: 0, failed: 0, skipped: 1 });
  });

  it("re-verify で row が消えている（findUnique null）→ skipped", async () => {
    wireFindMany([{ id: "s3", fileUrl: "/uploads/properties/p/attachments/s3.pdf" }]);
    pm.attachment.findUnique.mockResolvedValue(null);
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(pm.attachment.deleteMany).not.toHaveBeenCalled();
    expect(r).toEqual({ scanned: 1, purged: 0, failed: 0, skipped: 1 });
  });

  // ─── 7. deleteMany where shape (storage-first: assert where includes eligibility) ─
  it("deleteMany where に isDeleted/type/deletedAt 条件を維持（race ガード）", async () => {
    wireFindMany([{ id: "a1", fileUrl: "/uploads/properties/p/attachments/1.pdf" }], []);
    pm.attachment.findUnique.mockResolvedValue(validCurrent({ fileUrl: "/uploads/properties/p/attachments/1.pdf" }));
    await purgeExpiredAttachments({ now: NOW, limit: 200 });
    const delArg = pm.attachment.deleteMany.mock.calls[0][0];
    expect(delArg.where.id).toBe("a1");
    expect(delArg.where.isDeleted).toBe(true);
    expect(delArg.where.type).toEqual({ not: "registry" });
    expect(delArg.where.deletedAt).toMatchObject({ not: null, lte: expect.any(Date) });
  });

  // ─── 8. self-exclusion: findMany where includes id:{not: <row id>} ────
  it("isStorageKeyStillReferenced の attachment findMany where に id:{not: row.id} が含まれる（自己参照排除）", async () => {
    wireFindMany([{ id: "a1", fileUrl: "/uploads/properties/p/attachments/1.pdf" }], []);
    pm.attachment.findUnique.mockResolvedValue(validCurrent({ fileUrl: "/uploads/properties/p/attachments/1.pdf" }));
    await purgeExpiredAttachments({ now: NOW, limit: 200 });
    // The shared-key check call to findMany should have id:{not:"a1"}
    const sharedKeyCall = pm.attachment.findMany.mock.calls.find(
      (c: unknown[]) => (c[0] as { where?: { fileUrl?: { contains?: string } } } | undefined)?.where?.fileUrl?.contains !== undefined
    );
    expect(sharedKeyCall).toBeDefined();
    expect(sharedKeyCall![0].where).toMatchObject({ id: { not: "a1" } });
  });

  // ─── 9. shared key (another row references it): storage NOT deleted, DB row IS deleted ─
  it("他の添付行が同一 key を参照 → storage は消さず DB 行は purge（共有object保護）", async () => {
    wireFindMany(
      [{ id: "a4", fileUrl: "/uploads/properties/p/attachments/4.pdf" }],
      [{ fileUrl: "/uploads/properties/p/attachments/4.pdf" }], // another row references same key
    );
    pm.attachment.findUnique.mockResolvedValue(validCurrent({ fileUrl: "/uploads/properties/p/attachments/4.pdf" }));
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    expect(pm.attachment.deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(r).toEqual({ scanned: 1, purged: 1, failed: 0, skipped: 0 });
  });

  // ─── 10. 外部URL/不正URL: storage skip, row deleted ──────────────────
  it("外部URL/不正URL は storage を消さず行のみ削除（誤爆防止）", async () => {
    // data: URI has no /uploads/ path — extractor returns null → skip storage, purge row only
    wireFindMany([{ id: "a2", fileUrl: "data:application/pdf;base64,AAAA" }]);
    pm.attachment.findUnique.mockResolvedValue(validCurrent({ fileUrl: "data:application/pdf;base64,AAAA" }));
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    expect(pm.attachment.deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(r).toEqual({ scanned: 1, purged: 1, failed: 0, skipped: 0 });
  });

  // ─── 11. legacy absolute /uploads URL reclaim ────────────────────────
  it("legacy 絶対 /uploads URL は storage blob を回収する（legacy-aware ターゲット抽出）", async () => {
    const legacyUrl = "http://localhost:3000/uploads/properties/p/attachments/legacy.pdf";
    wireFindMany([{ id: "a6", fileUrl: legacyUrl }]);
    pm.attachment.findUnique.mockResolvedValue(validCurrent({ fileUrl: legacyUrl }));
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    expect(pm.attachment.deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith("properties/p/attachments/legacy.pdf");
    expect(r).toEqual({ scanned: 1, purged: 1, failed: 0, skipped: 0 });
  });

  // ─── 12. deleteMany count=0 after storage → skipped ──────────────────
  it("storage 削除後に deleteMany count=0（並行 purge/復元）→ skipped:1", async () => {
    wireFindMany([{ id: "a3", fileUrl: "/uploads/properties/p/attachments/3.pdf" }], []);
    pm.attachment.findUnique.mockResolvedValue(validCurrent({ fileUrl: "/uploads/properties/p/attachments/3.pdf" }));
    pm.attachment.deleteMany.mockResolvedValueOnce({ count: 0 });
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    // storage was already deleted, then deleteMany returned 0 → row was concurrently purged
    expect(r).toEqual({ scanned: 1, purged: 0, failed: 0, skipped: 1 });
  });

  // ─── 13. sibling legacy URL shared key → storage preserved ───────────
  it("sibling が legacy 絶対URL で同一 key を参照 → storage を消さない（legacy-aware 共有key検出）", async () => {
    wireFindMany(
      [{ id: "a5", fileUrl: "/uploads/properties/p/attachments/4.pdf" }],
      [{ fileUrl: "http://localhost:3000/uploads/properties/p/attachments/4.pdf" }],
    );
    pm.attachment.findUnique.mockResolvedValue(validCurrent({ fileUrl: "/uploads/properties/p/attachments/4.pdf" }));
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    expect(pm.attachment.deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(r).toEqual({ scanned: 1, purged: 1, failed: 0, skipped: 0 });
  });

  // ─── 14. PropertyPhoto fileUrl shared key → storage preserved ────────
  it("アクティブな PropertyPhoto が同一 key を参照 → storage を消さない（写真保護）", async () => {
    const key = "/uploads/properties/p/attachments/shared.pdf";
    wireFindMany([{ id: "c1", fileUrl: key }], []);
    pm.attachment.findUnique.mockResolvedValue(validCurrent({ fileUrl: key }));
    pm.attachment.deleteMany.mockResolvedValue({ count: 1 });
    pm.propertyPhoto.findMany.mockResolvedValue([{ fileUrl: key }]);
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(r).toEqual({ scanned: 1, purged: 1, failed: 0, skipped: 0 });
  });

  // ─── 15. BuildingPhoto fileUrl shared key → storage preserved ────────
  it("アクティブな BuildingPhoto が同一 key を参照 → storage を消さない（写真保護）", async () => {
    const key = "/uploads/properties/p/attachments/shared.pdf";
    wireFindMany([{ id: "c2", fileUrl: key }], []);
    pm.attachment.findUnique.mockResolvedValue(validCurrent({ fileUrl: key }));
    pm.attachment.deleteMany.mockResolvedValue({ count: 1 });
    pm.buildingPhoto.findMany.mockResolvedValue([{ fileUrl: key }]);
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(r).toEqual({ scanned: 1, purged: 1, failed: 0, skipped: 0 });
  });

  // ─── 16. PropertyPhoto thumbnailUrl shared key → storage preserved ────
  it("アクティブな PropertyPhoto が thumbnailUrl で同一 key を参照 → storage を消さない（サムネイル保護）", async () => {
    const key = "/uploads/properties/p/attachments/shared.pdf";
    wireFindMany([{ id: "c4", fileUrl: key }], []);
    pm.attachment.findUnique.mockResolvedValue(validCurrent({ fileUrl: key }));
    pm.attachment.deleteMany.mockResolvedValue({ count: 1 });
    pm.propertyPhoto.findMany.mockResolvedValue([
      { fileUrl: "/uploads/properties/p/photos/other.jpg", thumbnailUrl: key },
    ]);
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(r).toEqual({ scanned: 1, purged: 1, failed: 0, skipped: 0 });
  });

  // ─── 17. BuildingPhoto thumbnailUrl shared key → storage preserved ────
  it("アクティブな BuildingPhoto が thumbnailUrl で同一 key を参照 → storage を消さない（サムネイル保護）", async () => {
    const key = "/uploads/properties/p/attachments/shared.pdf";
    wireFindMany([{ id: "c5", fileUrl: key }], []);
    pm.attachment.findUnique.mockResolvedValue(validCurrent({ fileUrl: key }));
    pm.attachment.deleteMany.mockResolvedValue({ count: 1 });
    pm.buildingPhoto.findMany.mockResolvedValue([
      { fileUrl: "/uploads/properties/p/photos/other.jpg", thumbnailUrl: key },
    ]);
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(r).toEqual({ scanned: 1, purged: 1, failed: 0, skipped: 0 });
  });

  // ─── 18. FieldSurveyPinPhoto thumbnailUrl shared key → storage preserved
  it("FieldSurveyPinPhoto が thumbnailUrl で同一 key を参照 → storage を消さない（サムネイル保護）", async () => {
    const key = "/uploads/properties/p/attachments/shared.pdf";
    wireFindMany([{ id: "c3", fileUrl: key }], []);
    pm.attachment.findUnique.mockResolvedValue(validCurrent({ fileUrl: key }));
    pm.attachment.deleteMany.mockResolvedValue({ count: 1 });
    pm.fieldSurveyPinPhoto.findMany.mockResolvedValue([{ fileUrl: null, thumbnailUrl: key }]);
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(r).toEqual({ scanned: 1, purged: 1, failed: 0, skipped: 0 });
  });

  // ─── 19. batch continues past failure ────────────────────────────────
  it("storage.delete が失敗してもバッチは止まらず残りを処理", async () => {
    wireFindMany([
      { id: "b1", fileUrl: "/uploads/properties/p/attachments/b1.pdf" },
      { id: "b2", fileUrl: "/uploads/properties/p/attachments/b2.pdf" },
    ]);
    pm.attachment.findUnique
      .mockResolvedValueOnce(validCurrent({ fileUrl: "/uploads/properties/p/attachments/b1.pdf" }))
      .mockResolvedValueOnce(validCurrent({ fileUrl: "/uploads/properties/p/attachments/b2.pdf" }));
    deleteSpy.mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    // b1 storage failed → row kept; b2 storage ok → row deleted
    expect(pm.attachment.deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledTimes(2);
    expect(r).toEqual({ scanned: 2, purged: 1, failed: 1, skipped: 0 });
  });

  // ─── 20. no console.* on storage failure (PII guard) ─────────────────
  it("storage 失敗時に console.error を呼ばない（key/PII のログ出力禁止）", async () => {
    wireFindMany([{ id: "att-id-1", fileUrl: "/uploads/properties/p/attachments/PRIVATE-owner-name.pdf" }], []);
    pm.attachment.findUnique.mockResolvedValue(validCurrent({ fileUrl: "/uploads/properties/p/attachments/PRIVATE-owner-name.pdf" }));
    deleteSpy.mockRejectedValueOnce(new Error("storage failure"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await purgeExpiredAttachments({ now: NOW, limit: 200 });
    expect(errSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });
});
