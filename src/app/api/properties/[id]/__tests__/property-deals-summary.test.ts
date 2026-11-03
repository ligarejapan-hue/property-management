import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

/**
 * GET /api/properties/[id] の deals(取扱区分の横に並べる取引・2026-11-04)。
 * ⚠取引を見る権限(deal:read)が無い人には null(問い合わせも投げない)。
 * 返すのは番号・区分・状態・仕入/売却だけ(当事者の氏名などは返さない)。
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
  apiResponse: vi.fn((body: unknown, status = 200) => Response.json(body as object, { status })),
  handleApiError: vi.fn((e: { status?: number; message?: string; code?: string }) =>
    Response.json({ error: { message: e?.message, code: e?.code } }, { status: e?.status ?? 500 }),
  ),
}));
const permState = { dealRead: true };
vi.mock("@/lib/permissions", () => ({
  hasPermission: (_perms: unknown, resource: string, action: string) => {
    if (resource === "deal" && action === "read") return permState.dealRead;
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
    attachment: { groupBy: vi.fn(async () => []) },
    deal: { findMany: vi.fn() },
  },
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { GET } from "../route";

const pm = prisma as unknown as {
  property: { findUnique: Mock };
  importJobRow: { findFirst: Mock };
  deal: { findMany: Mock };
};

async function callGet() {
  const res = await GET({} as unknown as Parameters<typeof GET>[0], { params: Promise.resolve({ id: "p1" }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  permState.dealRead = true;
  (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Mock).mockResolvedValue([]);
  pm.importJobRow.findFirst.mockResolvedValue(null);
  pm.property.findUnique.mockResolvedValue({
    id: "p1", createdBy: "u1", assignedTo: null, building: null, businessType: "resale",
    propertyOwners: [], photos: [], nextActions: [],
  });
});

describe("GET /api/properties/[id] — 物件の取引", () => {
  it("取引を番号・区分・状態・仕入/売却で返す(この物件の分だけ・自社の当事者だけ読む)", async () => {
    pm.deal.findMany.mockResolvedValue([
      { id: "d2", dealNo: "2026-0031", businessType: "resale", status: "considering", parties: [{ role: "seller", isSelf: true }] },
      { id: "d1", dealNo: "2026-0012", businessType: "resale", status: "settled", parties: [{ role: "buyer", isSelf: true }] },
    ]);
    const { status, body } = await callGet();
    expect(status).toBe(200);
    expect(body.businessType).toBe("resale");
    expect(body.deals).toEqual([
      { id: "d2", dealNo: "2026-0031", businessType: "resale", status: "considering", side: "sale", label: "買取再販(売却)" },
      { id: "d1", dealNo: "2026-0012", businessType: "resale", status: "settled", side: "purchase", label: "買取再販(仕入)" },
    ]);
    const arg = pm.deal.findMany.mock.calls[0][0] as { where: unknown; select: { parties: { where: unknown; select: unknown } } };
    expect(arg.where).toEqual({ propertyId: "p1" });
    expect(arg.select.parties.where).toEqual({ isSelf: true });
    expect(arg.select.parties.select).toEqual({ role: true, isSelf: true });
  });

  it("取引を見る権限が無い人には null(問い合わせも投げない)", async () => {
    permState.dealRead = false;
    const { body } = await callGet();
    expect(body.deals).toBeNull();
    expect(pm.deal.findMany).not.toHaveBeenCalled();
  });
});
