import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

/**
 * GET /api/properties/[id] が返す registryObtainedAt(登記状況「取得済」の右の取得日・2026-11-06)。
 * 設定(モック)は registry-attachment-count.test.ts と同じ。以下は元の説明。
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
    auditLog: { findFirst: vi.fn() },
    // 取扱区分の横に並べる取引(2026-11-04)。中身は property-deals-summary.test.ts。
    deal: { findMany: vi.fn(async () => []) },
  },
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { GET } from "../route";

type PrismaMock = {
  property: { findUnique: Mock };
  importJobRow: { findFirst: Mock };
  attachment: { groupBy: Mock };
  auditLog: { findFirst: Mock };
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
  pm.property.findUnique.mockResolvedValue({ ...BASE_PROPERTY, registryStatus: "obtained" });
  pm.auditLog.findFirst.mockResolvedValue(null);
});

const D = (s: string) => new Date(s);

describe("GET /api/properties/[id] — registryObtainedAt", () => {
  it("★謄本の添付と取得の成功のうち、いちばん新しい日時を返す", async () => {
    pm.attachment.groupBy.mockResolvedValue([
      { registryCertificateType: "owner", _count: { _all: 1 }, _max: { createdAt: D("2026-10-01T00:00:00Z") } },
      { registryCertificateType: "all", _count: { _all: 1 }, _max: { createdAt: D("2026-10-20T00:00:00Z") } },
    ]);
    pm.auditLog.findFirst.mockResolvedValue({ createdAt: D("2026-11-05T00:00:00Z") });
    const { body } = await callGet();
    expect(body.registryObtainedAt).toBe("2026-11-05T00:00:00.000Z");
  });

  it("添付のほうが新しければ添付の日時", async () => {
    pm.attachment.groupBy.mockResolvedValue([
      { registryCertificateType: null, _count: { _all: 1 }, _max: { createdAt: D("2026-11-06T00:00:00Z") } },
    ]);
    pm.auditLog.findFirst.mockResolvedValue({ createdAt: D("2026-11-05T00:00:00Z") });
    const { body } = await callGet();
    expect(body.registryObtainedAt).toBe("2026-11-06T00:00:00.000Z");
  });

  it("取得の成功の記録は、この物件・成功だけを新しい順に1件", async () => {
    pm.attachment.groupBy.mockResolvedValue([]);
    await callGet();
    expect(pm.auditLog.findFirst).toHaveBeenCalledWith({
      where: { action: "registry_auto_fetch", targetTable: "properties", targetId: "p1", detail: { path: ["status"], equals: "success" } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    // 添付の集計は未削除だけ(削除した謄本の日時は含めない=発注者決定)。
    expect((pm.attachment.groupBy.mock.calls[0][0] as { where: Record<string, unknown> }).where.isDeleted).toBe(false);
  });

  it("★どちらも無ければ null(手で取得済にしただけ)", async () => {
    pm.attachment.groupBy.mockResolvedValue([]);
    const { body } = await callGet();
    expect(body.registryObtainedAt).toBeNull();
  });

  it("取得済でなければ null(取得の記録も読まない)", async () => {
    pm.property.findUnique.mockResolvedValue({ ...BASE_PROPERTY, registryStatus: "unconfirmed" });
    pm.attachment.groupBy.mockResolvedValue([
      { registryCertificateType: "owner", _count: { _all: 1 }, _max: { createdAt: D("2026-10-01T00:00:00Z") } },
    ]);
    const { body } = await callGet();
    expect(body.registryObtainedAt).toBeNull();
    expect(pm.auditLog.findFirst).not.toHaveBeenCalled();
  });

  it("謄本を見られない人には null(問い合わせも投げない)", async () => {
    permState.registryPreview = false;
    const { body } = await callGet();
    expect(body.registryObtainedAt).toBeNull();
    expect(pm.attachment.groupBy).not.toHaveBeenCalled();
    expect(pm.auditLog.findFirst).not.toHaveBeenCalled();
  });
});
