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
vi.mock("@/lib/prisma", () => ({
  default: {
    property: { findUnique: vi.fn() },
    importJobRow: { findFirst: vi.fn() },
    attachment: { groupBy: vi.fn() },
  },
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { GET } from "../route";

type PrismaMock = {
  property: { findUnique: Mock };
  importJobRow: { findFirst: Mock };
  attachment: { groupBy: Mock };
};
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
  permState.registryPreview = true;
  (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Mock).mockResolvedValue([]);
  pm.importJobRow.findFirst.mockResolvedValue(null);
  pm.property.findUnique.mockResolvedValue({ ...BASE_PROPERTY });
});

describe("GET /api/properties/[id] — registryAttachmentCounts", () => {
  it("種別ごとに集計する(所有者事項=owner/全部事項=all/その他)", async () => {
    pm.attachment.groupBy.mockResolvedValue([
      { registryCertificateType: "owner", _count: { _all: 2 } },
      { registryCertificateType: "all", _count: { _all: 1 } },
      { registryCertificateType: null, _count: { _all: 3 } },
    ]);
    const { status, body } = await callGet();
    expect(status).toBe(200);
    expect(body.registryAttachmentCounts).toEqual({ owner: 2, all: 1, other: 3 });
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
