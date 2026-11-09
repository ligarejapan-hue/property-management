import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

/**
 * GET /api/properties/[id] が返す registryAttachmentCounts の検証。
 *
 * 物件基本情報の「謄本 ○件」行のためのデータ。件数は種別ごと(所有者事項/全部事項/その他)に
 * 集計し、⚠**registry_pdf:preview を持たない閲覧者には null**(件数もファイル名も渡さない=
 * 画面は行自体を出さない)。ファイル名/所在は一切返さない(基本情報の伏せ字方針)。
 * 集計条件は添付タブ(attachments GET)と同一: targetType=property/targetId/type=registry/isDeleted=false。
 */

vi.mock("@/lib/api-helpers", () => ({
  ApiError: class extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  getApiSession: vi.fn(),
  getUserPermissions: vi.fn(),
  getOwnerDisplayConfig: vi.fn(),
  apiResponse: vi.fn((body: unknown, status = 200) =>
    Response.json(body as object, { status }),
  ),
  handleApiError: vi.fn((e: { status?: number; message?: string; code?: string }) =>
    Response.json({ error: { message: e?.message, code: e?.code } }, { status: e?.status ?? 500 }),
  ),
}));
// registry_pdf:preview の有無をテストごとに切り替えられる実装にする。
const permState = { registryPreview: true };
vi.mock("@/lib/permissions", () => ({
  hasPermission: (_perms: unknown, resource: string, action: string) => {
    if (resource === "registry_pdf" && action === "preview") return permState.registryPreview;
    return true;
  },
}));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/display-level", () => ({ applyDisplayToOwner: vi.fn() }));
vi.mock("@/lib/storage", () => ({ getStorage: vi.fn() }));
vi.mock("@/lib/storage/url-to-key", () => ({ extractStorageKeyFromUrl: vi.fn() }));
// 種別の列が空の謄本の見分けは本物を通し、PDF の読み取りだけ差し替える(中身は registry-count-classify.test.ts)。
const readState = vi.hoisted(() => ({ read: vi.fn<(url: string) => Promise<string | null>>() }));
vi.mock("@/lib/attachments/registry-count-classify", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/attachments/registry-count-classify")>();
  return {
    ...real,
    countRegistryAttachmentGroups: (...[g, load]: Parameters<typeof real.countRegistryAttachmentGroups>) =>
      real.countRegistryAttachmentGroups(g, load, { read: (url) => readState.read(url) }),
  };
});
vi.mock("@/lib/prisma", () => ({
  default: {
    property: { findUnique: vi.fn() },
    importJobRow: { findFirst: vi.fn() },
    attachment: { groupBy: vi.fn(), findMany: vi.fn() },
    // 取扱区分の横に並べる取引(2026-11-04)。中身は property-deals-summary.test.ts。
    deal: { findMany: vi.fn(async () => []) },
  },
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { resetRegistryCountCacheForTest } from "@/lib/attachments/registry-count-classify";
import { GET } from "../route";

type PrismaMock = {
  property: { findUnique: Mock };
  importJobRow: { findFirst: Mock };
  attachment: { groupBy: Mock; findMany: Mock };
};
const FULL_TEXT = "表 題 部\n権 利 部 （ 甲 区 ） （ 所 有 権 に 関 す る 事 項 ）";
const OWNER_TEXT = [
  "┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓",
  "┃ 所 有 者 ┃",
  "┠────────────────────┬─────────────┨",
  "┃ 住 所 │ 氏 名 ┃",
  "┠────────────────────┼─────────────┨",
  "┃架空県架空市一丁目1番1号 │架空太郎 ┃",
  "┗━━━━━━━━━━━━━━━━━━┷━━━━━━━━━┛",
].join("\n");
const pm = prisma as unknown as PrismaMock;

const BASE_PROPERTY = {
  id: "p1",
  createdBy: "u1",
  assignedTo: null,
  building: null,
  propertyOwners: [] as unknown[],
  photos: [] as unknown[],
  nextActions: [] as unknown[],
};

async function callGet(id = "p1") {
  const res = await GET({} as unknown as Parameters<typeof GET>[0], {
    params: Promise.resolve({ id }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRegistryCountCacheForTest();
  permState.registryPreview = true;
  (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Mock).mockResolvedValue([]);
  pm.importJobRow.findFirst.mockResolvedValue(null);
  pm.property.findUnique.mockResolvedValue({ ...BASE_PROPERTY });
});

describe("GET /api/properties/[id] — registryAttachmentCounts", () => {
  it("種別ごとに集計する(所有者事項=owner/全部事項=all/列が空は本文で見分けた結果を足す)", async () => {
    pm.attachment.groupBy.mockResolvedValue([
      { registryCertificateType: "owner", _count: { _all: 2 } },
      { registryCertificateType: "all", _count: { _all: 1 } },
      { registryCertificateType: null, _count: { _all: 3 } },
    ]);
    const untyped = [
      { id: "a1", fileUrl: "/uploads/x1.pdf", fileSize: 1, mimeType: "application/pdf" },
      { id: "a2", fileUrl: "/uploads/x2.pdf", fileSize: 1, mimeType: "application/pdf" },
      { id: "a3", fileUrl: "/uploads/x3.jpg", fileSize: 1, mimeType: "image/jpeg" },
    ];
    pm.attachment.findMany.mockResolvedValue(untyped);
    readState.read.mockImplementation(async (url) => (url.endsWith("x1.pdf") ? FULL_TEXT : OWNER_TEXT));
    const { status, body } = await callGet();
    expect(status).toBe(200);
    // x1=全部事項・x2=所有者事項・x3=画像の謄本(読まずにその他)
    expect(body.registryAttachmentCounts).toEqual({ owner: 3, all: 2, other: 1 });
    expect(readState.read).toHaveBeenCalledTimes(2);
    // 2回目に開いたときは読み直さない
    const again = await callGet();
    expect(again.body.registryAttachmentCounts).toEqual({ owner: 3, all: 2, other: 1 });
    expect(readState.read).toHaveBeenCalledTimes(2);
    // 見るのは同じ物件の・未削除の・列が空の謄本だけ
    expect(pm.attachment.findMany.mock.calls[0][0].where).toEqual({
      targetType: "property",
      targetId: "p1",
      type: "registry",
      isDeleted: false,
      registryCertificateType: null,
    });
  });

  it("列が空の謄本が無ければ、読みに行かない", async () => {
    pm.attachment.groupBy.mockResolvedValue([
      { registryCertificateType: "owner", _count: { _all: 1 } },
    ]);
    await callGet();
    expect(pm.attachment.findMany).not.toHaveBeenCalled();
    expect(readState.read).not.toHaveBeenCalled();
  });

  it("見分けに失敗しても画面は出す(列が空の分は「その他」)", async () => {
    pm.attachment.groupBy.mockResolvedValue([
      { registryCertificateType: "all", _count: { _all: 1 } },
      { registryCertificateType: null, _count: { _all: 2 } },
    ]);
    pm.attachment.findMany.mockRejectedValue(new Error("boom"));
    const { status, body } = await callGet();
    expect(status).toBe(200);
    expect(body.registryAttachmentCounts).toEqual({ owner: 0, all: 1, other: 2 });
  });

  it("集計条件は添付タブと同一(property/targetId/registry/未削除)", async () => {
    pm.attachment.groupBy.mockResolvedValue([]);
    await callGet();
    expect(pm.attachment.groupBy).toHaveBeenCalledTimes(1);
    const arg = pm.attachment.groupBy.mock.calls[0][0] as {
      by: string[];
      where: Record<string, unknown>;
    };
    expect(arg.by).toEqual(["registryCertificateType"]);
    expect(arg.where).toEqual({
      targetType: "property",
      targetId: "p1",
      type: "registry",
      isDeleted: false,
    });
  });

  it("謄本が無ければ 0件(owner:0/all:0/other:0)", async () => {
    pm.attachment.groupBy.mockResolvedValue([]);
    const { body } = await callGet();
    expect(body.registryAttachmentCounts).toEqual({ owner: 0, all: 0, other: 0 });
  });

  it("registry_pdf:preview が無い閲覧者には null(集計クエリも投げない=件数を漏らさない)", async () => {
    permState.registryPreview = false;
    const { body } = await callGet();
    expect(body.registryAttachmentCounts).toBeNull();
    expect(pm.attachment.groupBy).not.toHaveBeenCalled();
  });

  it("応答にファイル名/所在などの謄本メタを含めない(件数のみ)", async () => {
    pm.attachment.groupBy.mockResolvedValue([
      { registryCertificateType: "owner", _count: { _all: 1 } },
    ]);
    const { body } = await callGet();
    const serialized = JSON.stringify(body.registryAttachmentCounts);
    expect(serialized).not.toContain("fileName");
    expect(serialized).not.toContain("fileUrl");
    expect(serialized).not.toContain("不動産登記");
  });
});
