import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

const { deleteSpy } = vi.hoisted(() => ({ deleteSpy: vi.fn() }));

// keyFromUrl: resolves /uploads/{key} (any host) and /:bucket/{key} for server backend.
// The test bucket is "testbucket" (matches server URLs used in tests).
function testKeyFromUrl(u: string | null | undefined): string | null {
  if (typeof u !== "string") return null;
  let p: string;
  try {
    p = u.startsWith("/") ? u.split(/[?#]/)[0] : new URL(u).pathname;
  } catch {
    return u.split(/[?#]/)[0];
  }
  // data:/blob:/file: → null
  if (/^(data|blob|file):/i.test(u)) return null;
  // server backend URL /:bucket/{key}
  const bp = "/testbucket/";
  if (p.startsWith(bp)) return p.slice(bp.length) || null;
  // local/s3/legacy /uploads/{key}
  const up = p.indexOf("/uploads/");
  if (up !== -1) return p.slice(up + "/uploads/".length) || null;
  return null;
}

vi.mock("@/lib/storage", () => ({
  getStorage: () => ({
    delete: deleteSpy,
    keyFromUrl: testKeyFromUrl,
  }),
}));
vi.mock("@/lib/prisma", () => ({
  default: {
    attachment: { findMany: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    propertyPhoto: { findMany: vi.fn() },
    buildingPhoto: { findMany: vi.fn() },
    fieldSurveyPinPhoto: { findMany: vi.fn() },
  },
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
  STALE_PURGE_CLAIM_MS,
} from "../attachment-cleanup";

const pm = prisma as unknown as {
  attachment: { findMany: Mock; updateMany: Mock; deleteMany: Mock };
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

beforeEach(() => {
  vi.clearAllMocks();
  deleteSpy.mockResolvedValue(undefined);
  // claim updateMany: first call = CLAIM (count 1), further calls = RELEASE (count 1)
  pm.attachment.updateMany.mockResolvedValue({ count: 1 });
  pm.attachment.deleteMany.mockResolvedValue({ count: 1 });
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
  it("isDeleted=true / type≠registry / deletedAt<=cutoff / OR[purgeStartedAt:null|stale] / 件数上限 を where に反映", async () => {
    await findPurgeableAttachments(NOW, 200);
    const arg = pm.attachment.findMany.mock.calls[0][0];
    expect(arg.where.isDeleted).toBe(true);
    expect(arg.where.type).toEqual({ not: "registry" });
    expect(arg.where.deletedAt.not).toBe(null);
    expect(arg.where.deletedAt.lte).toBeInstanceOf(Date);
    // stale-claim lease: null OR stale (lte staleClaimCutoff) — fresh claims excluded
    expect(arg.where.OR).toEqual([
      { purgeStartedAt: null },
      { purgeStartedAt: { lte: expect.any(Date) } },
    ]);
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
    expect(pm.attachment.updateMany).not.toHaveBeenCalled();
    expect(pm.attachment.deleteMany).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  // ─── 2. CLAIM success → storage delete → finalize deleteMany → purged:1 ─
  it("CLAIM成功 → storage削除 → finalize deleteMany → purged:1 failed:0", async () => {
    wireFindMany([{ id: "a1", fileUrl: "/uploads/properties/p/attachments/1.pdf" }], []);
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    // claim updateMany where: OR[purgeStartedAt:null | stale lte] — fresh claims not re-claimable
    const claimCall = pm.attachment.updateMany.mock.calls[0][0];
    expect(claimCall.where.id).toBe("a1");
    expect(claimCall.where.isDeleted).toBe(true);
    expect(claimCall.where.type).toEqual({ not: "registry" });
    expect(claimCall.where.deletedAt.not).toBe(null);
    expect(claimCall.where.deletedAt.lte).toBeInstanceOf(Date);
    expect(claimCall.where.OR).toEqual([
      { purgeStartedAt: null },
      { purgeStartedAt: { lte: expect.any(Date) } },
    ]);
    expect(claimCall.data.purgeStartedAt).toBeInstanceOf(Date);
    // storage deleted
    expect(deleteSpy).toHaveBeenCalledWith("properties/p/attachments/1.pdf");
    // finalize deleteMany called
    expect(pm.attachment.deleteMany).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ scanned: 1, purged: 1, failed: 0, skipped: 0 });
  });

  // ─── 3. CLAIM returns count 0 → skipped 1, no storage, no finalize ─────
  it("CLAIM count=0（復元済み/既にclaimedの場合）→ skipped:1、storage不変、deleteMany不呼", async () => {
    wireFindMany([{ id: "a1", fileUrl: "/uploads/properties/p/attachments/1.pdf" }], []);
    pm.attachment.updateMany.mockResolvedValueOnce({ count: 0 }); // claim fails
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(pm.attachment.deleteMany).not.toHaveBeenCalled();
    expect(r).toEqual({ scanned: 1, purged: 0, failed: 0, skipped: 1 });
  });

  // ─── 4. storage delete FAILURE → RELEASE claim → failed:1, deleteMany NOT called ──
  it("storage.delete 失敗 → claim RELEASE（updateMany purgeStartedAt:null）+ failed:1 purged:0（次回再試行）", async () => {
    wireFindMany([{ id: "a1", fileUrl: "/uploads/properties/p/attachments/1.pdf" }], []);
    deleteSpy.mockRejectedValueOnce(new Error("boom"));
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    // storage was attempted
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    // RELEASE call: updateMany called twice — first CLAIM, second RELEASE
    expect(pm.attachment.updateMany).toHaveBeenCalledTimes(2);
    const releaseCall = pm.attachment.updateMany.mock.calls[1][0];
    expect(releaseCall.where).toMatchObject({ id: "a1" });
    expect(releaseCall.data).toEqual({ purgeStartedAt: null });
    // finalize deleteMany NOT called
    expect(pm.attachment.deleteMany).not.toHaveBeenCalled();
    expect(r).toEqual({ scanned: 1, purged: 0, failed: 1, skipped: 0 });
  });

  // ─── 5. finalize deleteMany where includes purgeStartedAt:{not:null} ────
  it("finalize deleteMany where に purgeStartedAt:{not:null} が含まれる（race ガード）", async () => {
    wireFindMany([{ id: "a1", fileUrl: "/uploads/properties/p/attachments/1.pdf" }], []);
    await purgeExpiredAttachments({ now: NOW, limit: 200 });
    const delArg = pm.attachment.deleteMany.mock.calls[0][0];
    expect(delArg.where.id).toBe("a1");
    expect(delArg.where.isDeleted).toBe(true);
    expect(delArg.where.type).toEqual({ not: "registry" });
    expect(delArg.where.deletedAt).toMatchObject({ not: null, lte: expect.any(Date) });
    expect(delArg.where.purgeStartedAt).toMatchObject({ not: null });
  });

  // ─── 6. storage delete SUCCESS → DB row deleted, purged:1, failed:0 ────
  it("自前 storage key・他参照なし → storage 削除後に deleteMany、purged:1 failed:0", async () => {
    wireFindMany([{ id: "a1", fileUrl: "/uploads/properties/p/attachments/1.pdf" }], []);
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    expect(deleteSpy).toHaveBeenCalledWith("properties/p/attachments/1.pdf");
    const delArg = pm.attachment.deleteMany.mock.calls[0][0];
    expect(delArg.where).toMatchObject({ id: "a1", isDeleted: true, type: { not: "registry" } });
    expect(delArg.where.deletedAt.not).toBe(null);
    expect(delArg.where.deletedAt.lte).toBeInstanceOf(Date);
    expect(r).toEqual({ scanned: 1, purged: 1, failed: 0, skipped: 0 });
  });

  // ─── 7. storage failure NOT counted as purged ──────────────────────────
  it("storage 失敗は purged にカウントされない・success として握りつぶさない", async () => {
    wireFindMany([
      { id: "b1", fileUrl: "/uploads/properties/p/attachments/b1.pdf" },
      { id: "b2", fileUrl: "/uploads/properties/p/attachments/b2.pdf" },
    ]);
    deleteSpy.mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    // b1 failed, b2 succeeded
    expect(r.failed).toBe(1);
    expect(r.purged).toBe(1);
    expect(r.failed + r.purged).toBe(2);
    // b1 row kept (deleteMany called only once, for b2)
    expect(pm.attachment.deleteMany).toHaveBeenCalledTimes(1);
    expect(pm.attachment.deleteMany.mock.calls[0][0].where.id).toBe("b2");
  });

  // ─── 8. shared key (another row references it): storage NOT deleted, DB row IS deleted ─
  it("他の添付行が同一 key を参照 → storage は消さず DB 行は purge（共有object保護）", async () => {
    wireFindMany(
      [{ id: "a4", fileUrl: "/uploads/properties/p/attachments/4.pdf" }],
      [{ fileUrl: "/uploads/properties/p/attachments/4.pdf" }],
    );
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    expect(pm.attachment.deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(r).toEqual({ scanned: 1, purged: 1, failed: 0, skipped: 0 });
  });

  // ─── 9. self-exclusion: findMany where includes id:{not: <row id>} ────
  it("isStorageKeyStillReferenced の attachment findMany where に id:{not: row.id} が含まれる（自己参照排除）", async () => {
    wireFindMany([{ id: "a1", fileUrl: "/uploads/properties/p/attachments/1.pdf" }], []);
    await purgeExpiredAttachments({ now: NOW, limit: 200 });
    const sharedKeyCall = pm.attachment.findMany.mock.calls.find(
      (c: unknown[]) => (c[0] as { where?: { fileUrl?: { contains?: string } } } | undefined)?.where?.fileUrl?.contains !== undefined
    );
    expect(sharedKeyCall).toBeDefined();
    expect(sharedKeyCall![0].where).toMatchObject({ id: { not: "a1" } });
  });

  // ─── 10. 外部URL/不正URL: storage skip, row deleted ──────────────────
  it("外部URL/不正URL は storage を消さず行のみ削除（誤爆防止）", async () => {
    wireFindMany([{ id: "a2", fileUrl: "data:application/pdf;base64,AAAA" }]);
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    expect(pm.attachment.deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(r).toEqual({ scanned: 1, purged: 1, failed: 0, skipped: 0 });
  });

  // ─── 11. legacy absolute /uploads URL reclaim ────────────────────────
  it("legacy 絶対 /uploads URL は storage blob を回収する（legacy-aware ターゲット抽出）", async () => {
    const legacyUrl = "http://localhost:3000/uploads/properties/p/attachments/legacy.pdf";
    wireFindMany([{ id: "a6", fileUrl: legacyUrl }]);
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    expect(pm.attachment.deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith("properties/p/attachments/legacy.pdf");
    expect(r).toEqual({ scanned: 1, purged: 1, failed: 0, skipped: 0 });
  });

  // ─── 12. deleteMany count=0 after storage → skipped ──────────────────
  it("finalize deleteMany count=0（並行 purge/復元）→ skipped:1", async () => {
    wireFindMany([{ id: "a3", fileUrl: "/uploads/properties/p/attachments/3.pdf" }], []);
    pm.attachment.deleteMany.mockResolvedValueOnce({ count: 0 });
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    expect(r).toEqual({ scanned: 1, purged: 0, failed: 0, skipped: 1 });
  });

  // ─── 13. sibling legacy URL shared key → storage preserved ───────────
  it("sibling が legacy 絶対URL で同一 key を参照 → storage を消さない（legacy-aware 共有key検出）", async () => {
    wireFindMany(
      [{ id: "a5", fileUrl: "/uploads/properties/p/attachments/4.pdf" }],
      [{ fileUrl: "http://localhost:3000/uploads/properties/p/attachments/4.pdf" }],
    );
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    expect(pm.attachment.deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(r).toEqual({ scanned: 1, purged: 1, failed: 0, skipped: 0 });
  });

  // ─── 14. PropertyPhoto fileUrl shared key → storage preserved ────────
  it("アクティブな PropertyPhoto が同一 key を参照 → storage を消さない（写真保護）", async () => {
    const key = "/uploads/properties/p/attachments/shared.pdf";
    wireFindMany([{ id: "c1", fileUrl: key }], []);
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
    deleteSpy.mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    expect(pm.attachment.deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledTimes(2);
    expect(r).toEqual({ scanned: 2, purged: 1, failed: 1, skipped: 0 });
  });

  // ─── 20. no console.* on storage failure (PII guard) ─────────────────
  it("storage 失敗時に console.error を呼ばない（key/PII のログ出力禁止）", async () => {
    wireFindMany([{ id: "att-id-1", fileUrl: "/uploads/properties/p/attachments/PRIVATE-owner-name.pdf" }], []);
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

  // ─── 21. server-backend URL reclaim (codex round-12 B-fix) ────────────
  it("server backend URL /:bucket/{key} → keyFromUrl で key 解決 → storage.delete 呼ばれる（blob 回収）", async () => {
    const serverUrl = "http://srv:9000/testbucket/properties/p/attachments/x.pdf";
    wireFindMany([{ id: "s1", fileUrl: serverUrl }], []);
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    expect(deleteSpy).toHaveBeenCalledWith("properties/p/attachments/x.pdf");
    expect(pm.attachment.deleteMany).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ scanned: 1, purged: 1, failed: 0, skipped: 0 });
  });

  // ─── 22. data: URL → no storage delete, row still finalized ──────────
  it("data: URL → keyFromUrl が null → storage 未削除・行は finalize される", async () => {
    wireFindMany([{ id: "d1", fileUrl: "data:application/pdf;base64,AAAA" }], []);
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(pm.attachment.deleteMany).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ scanned: 1, purged: 1, failed: 0, skipped: 0 });
  });

  // ─── 23. stale-claimed row is RECLAIMED (claim updateMany returns count:1) ─
  it("stale claim（purgeStartedAt が STALE_PURGE_CLAIM_MS より古い）→ 再 claim され purge される", async () => {
    // A stale-claimed row appears in findPurgeableAttachments results (OR condition allows it).
    // The claim updateMany returns count:1 (we atomically re-claimed it).
    wireFindMany([{ id: "st1", fileUrl: "/uploads/properties/p/attachments/stale.pdf" }], []);
    // default mock: updateMany count:1, deleteMany count:1
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    // CLAIM where has OR with stale lte
    const claimCall = pm.attachment.updateMany.mock.calls[0][0];
    expect(claimCall.where.OR).toEqual([
      { purgeStartedAt: null },
      { purgeStartedAt: { lte: expect.any(Date) } },
    ]);
    // staleClaimCutoff = now - STALE_PURGE_CLAIM_MS
    const staleClaimCutoff = new Date(NOW.getTime() - STALE_PURGE_CLAIM_MS);
    expect(claimCall.where.OR[1].purgeStartedAt.lte.getTime()).toBe(staleClaimCutoff.getTime());
    // proceeds to storage delete and finalize
    expect(deleteSpy).toHaveBeenCalledWith("properties/p/attachments/stale.pdf");
    expect(pm.attachment.deleteMany).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ scanned: 1, purged: 1, failed: 0, skipped: 0 });
  });

  // ─── 24. FRESH-claimed row → CLAIM count:0 → skipped (lease respected) ──
  it("FRESH claim（purgeStartedAt が lease 内）→ claim count:0 → skipped:1、storage/finalize 未呼", async () => {
    // A fresh-claimed row's claim updateMany returns count:0 (we did NOT re-claim it —
    // the OR condition excludes it because purgeStartedAt > staleClaimCutoff).
    wireFindMany([{ id: "fr1", fileUrl: "/uploads/properties/p/attachments/fresh.pdf" }], []);
    pm.attachment.updateMany.mockResolvedValueOnce({ count: 0 }); // lease alive, not re-claimable
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(pm.attachment.deleteMany).not.toHaveBeenCalled();
    expect(r).toEqual({ scanned: 1, purged: 0, failed: 0, skipped: 1 });
  });
});
