import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

const { deleteSpy } = vi.hoisted(() => ({ deleteSpy: vi.fn() }));
vi.mock("@/lib/storage", () => ({ getStorage: () => ({ delete: deleteSpy }) }));
vi.mock("@/lib/prisma", () => ({
  default: {
    attachment: { findMany: vi.fn(), deleteMany: vi.fn() },
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
  attachment: { findMany: Mock; deleteMany: Mock };
  propertyPhoto: { findMany: Mock };
  buildingPhoto: { findMany: Mock };
  fieldSurveyPinPhoto: { findMany: Mock };
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
    // data: URI has no /uploads/ path — extractor returns null → skip storage, purge row only
    wireFindMany([{ id: "a2", fileUrl: "data:application/pdf;base64,AAAA" }]);
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    expect(pm.attachment.deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(r.purged).toBe(1);
  });

  it("legacy 絶対 /uploads URL は storage blob を回収する（legacy-aware ターゲット抽出）", async () => {
    // fileUrl stored as absolute same-host URL (legacy); extractor strips host → key resolved
    wireFindMany([
      { id: "a6", fileUrl: "http://localhost:3000/uploads/properties/p/attachments/legacy.pdf" },
    ]);
    // no other row references this key (all shared-key checks return [])
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    expect(pm.attachment.deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith("properties/p/attachments/legacy.pdf");
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

  it("sibling が legacy 絶対URL で同一 key を参照 → storage を消さない（legacy-aware 共有key検出）", async () => {
    // purge 対象は相対 URL、sibling は同一 key への legacy 絶対 URL
    wireFindMany(
      [{ id: "a5", fileUrl: "/uploads/properties/p/attachments/4.pdf" }],
      [{ fileUrl: "http://localhost:3000/uploads/properties/p/attachments/4.pdf" }],
    );
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    expect(pm.attachment.deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteSpy).not.toHaveBeenCalled(); // storage preserved — legacy sibling detected
    expect(r.purged).toBe(1);
  });

  it("アクティブな PropertyPhoto が同一 key を参照 → storage を消さない（写真保護）", async () => {
    const key = "/uploads/properties/p/attachments/shared.pdf";
    wireFindMany([{ id: "c1", fileUrl: key }], []); // attachment shared-key check returns []
    pm.attachment.deleteMany.mockResolvedValue({ count: 1 });
    pm.propertyPhoto.findMany.mockResolvedValue([{ fileUrl: key }]);
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(r.purged).toBe(1);
  });

  it("アクティブな BuildingPhoto が同一 key を参照 → storage を消さない（写真保護）", async () => {
    const key = "/uploads/properties/p/attachments/shared.pdf";
    wireFindMany([{ id: "c2", fileUrl: key }], []);
    pm.attachment.deleteMany.mockResolvedValue({ count: 1 });
    pm.buildingPhoto.findMany.mockResolvedValue([{ fileUrl: key }]);
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(r.purged).toBe(1);
  });

  it("FieldSurveyPinPhoto が thumbnailUrl で同一 key を参照 → storage を消さない（サムネイル保護）", async () => {
    const key = "/uploads/properties/p/attachments/shared.pdf";
    wireFindMany([{ id: "c3", fileUrl: key }], []);
    pm.attachment.deleteMany.mockResolvedValue({ count: 1 });
    pm.fieldSurveyPinPhoto.findMany.mockResolvedValue([{ fileUrl: null, thumbnailUrl: key }]);
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
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

  it("storage.delete 失敗ログに PII (storage key) を含まず attachment id のみ記録", async () => {
    // PII-like token in fileUrl that is NOT a substring of the id
    wireFindMany([
      { id: "att-id-1", fileUrl: "/uploads/properties/p/attachments/PRIVATE-owner-name.pdf" },
      { id: "att-id-2", fileUrl: "/uploads/properties/p/attachments/safe.pdf" },
    ]);
    deleteSpy.mockRejectedValueOnce(new Error("storage failure")).mockResolvedValue(undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await purgeExpiredAttachments({ now: NOW, limit: 200 });
    // batch continues
    expect(pm.attachment.deleteMany).toHaveBeenCalledTimes(2);
    expect(deleteSpy).toHaveBeenCalledTimes(2);
    expect(r).toEqual({ scanned: 2, purged: 2 });
    // error was logged
    expect(errSpy).toHaveBeenCalled();
    // concatenate all args of every call to check content
    const logged = errSpy.mock.calls
      .flatMap((args) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))))
      .join(" ");
    // PII token must NOT appear
    expect(logged).not.toContain("PRIVATE-owner-name");
    // full key path must NOT appear
    expect(logged).not.toContain("properties/p/attachments/PRIVATE-owner-name.pdf");
    // attachment id MUST appear
    expect(logged).toContain("att-id-1");
    errSpy.mockRestore();
  });
});
