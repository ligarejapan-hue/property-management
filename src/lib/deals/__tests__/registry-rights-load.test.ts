import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ default: { attachment: { findMany: vi.fn() } } }));
vi.mock("@/lib/storage", () => {
  const files = new Map<string, Buffer>();
  return {
    __files: files,
    getStorage: () => ({
      keyFromUrl: (u: string | null) => (u ? u.replace(/^\/uploads\//, "") : null),
      read: async (k: string) => (files.has(k) ? { body: files.get(k)! } : null),
    }),
  };
});
vi.mock("@/lib/pdf-extract", () => ({ extractTextFromPdf: vi.fn(async (b: Buffer) => b.toString("utf8")) }));
vi.mock("@/lib/registry-strike", async (orig) => ({
  ...(await orig<typeof import("@/lib/registry-strike")>()),
  summarizeRegistryRights: vi.fn(),
}));

import prismaMock from "@/lib/prisma";
import * as storageMod from "@/lib/storage";
import { summarizeRegistryRights } from "@/lib/registry-strike";
import { loadDealRegistryRights } from "../registry-rights-load";

type Fn = ReturnType<typeof vi.fn>;
const findMany = (prismaMock as never as { attachment: { findMany: Fn } }).attachment.findMany;
const files = (storageMod as unknown as { __files: Map<string, Buffer> }).__files;
const FULL = "表題部 権 利 部 （ 甲 区 ） 所有権 権利部(乙区)";
const OWNER = "所有者事項証明書 所有者 架空";
const SUMMARY = { hasKouku: true, activeRights: [], cautions: [], notes: [] };
const att = (id: string, certType: string | null, at = "2026-10-0" + id.slice(-1)) => ({
  id, fileUrl: `/uploads/${id}.pdf`, registryCertificateType: certType, createdAt: new Date(`${at}T00:00:00Z`),
});

beforeEach(() => {
  vi.clearAllMocks();
  files.clear();
  (summarizeRegistryRights as Fn).mockResolvedValue(SUMMARY);
});

describe("取引の物件の謄本を読む(段5c-2)", () => {
  it("物件が無ければ何も読まない", async () => {
    expect(await loadDealRegistryRights(null)).toEqual({ status: "none" });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("所有者事項でない新しい順の添付から、本文が全部事項の最初の1件を PDF ごと判定する", async () => {
    findMany.mockResolvedValue([att("a3", null), att("a2", "all"), att("a1", "all")]);
    files.set("a3.pdf", Buffer.from(OWNER)); // 手で取り込んだ所有者事項(種別が空)
    files.set("a2.pdf", Buffer.from(FULL));
    files.set("a1.pdf", Buffer.from(FULL));
    const r = await loadDealRegistryRights("p1");
    expect(r).toEqual({ status: "ok", attachmentCreatedAt: "2026-10-02T00:00:00.000Z", summary: SUMMARY });
    const where = findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ propertyId: "p1", type: "registry", isDeleted: false });
    expect(where.OR).toEqual([{ registryCertificateType: null }, { registryCertificateType: { not: "owner" } }]);
    expect(findMany.mock.calls[0][0].orderBy).toEqual({ createdAt: "desc" });
    expect(findMany.mock.calls[0][0].take).toBe(5);
    expect((summarizeRegistryRights as Fn).mock.calls).toHaveLength(1);
    expect((summarizeRegistryRights as Fn).mock.calls[0][0].pdf.toString()).toBe(FULL);
  });

  it("全部事項が無ければ none・全部事項なのに判定できない/ファイルが無いときは unreadable", async () => {
    findMany.mockResolvedValue([att("a1", null)]);
    files.set("a1.pdf", Buffer.from(OWNER));
    expect(await loadDealRegistryRights("p1")).toEqual({ status: "none" });

    findMany.mockResolvedValue([att("a1", "all")]);
    files.set("a1.pdf", Buffer.from(FULL));
    (summarizeRegistryRights as Fn).mockResolvedValue(null);
    expect(await loadDealRegistryRights("p1")).toEqual({ status: "unreadable" });

    files.clear();
    expect(await loadDealRegistryRights("p1")).toEqual({ status: "unreadable" });
  });

  it("全部事項と分かっている添付が全部事項として読めない(画像だけの PDF など)ときは飛ばさず unreadable", async () => {
    findMany.mockResolvedValue([att("a2", "all"), att("a1", "all")]);
    files.set("a2.pdf", Buffer.from("-- 1 of 1 --"));
    files.set("a1.pdf", Buffer.from(FULL));
    expect(await loadDealRegistryRights("p1")).toEqual({ status: "unreadable" });
    expect(summarizeRegistryRights).not.toHaveBeenCalled();
  });

  it("種別が空でファイルが読めない添付は飛ばして次を見る", async () => {
    findMany.mockResolvedValue([att("a2", null), att("a1", "all")]);
    files.set("a1.pdf", Buffer.from(FULL));
    expect((await loadDealRegistryRights("p1")).status).toBe("ok");
  });
});
