import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// 削除系 route の認可ゲート（総点検 2026-07-27 P1-1）。
//
// 物件・棟の DELETE は `property:write` しか見ておらず、権限テンプレートの
// 「削除」トグル（seed 既定では現地担当/事務担当 = delete:false）が実質無効だった。
// 削除は物理削除 + cascade（PropertyOwner / PropertyPhoto 実体 / Comment /
// NextAction / PropertyDmLog / SalesSheetDesign …）で取り消せないため、
// write しか無いユーザーが削除できてしまうのは実害が大きい。
//
// ここでは「delete が無い → 403 で prisma に一切触れない」「delete がある →
// 認可を通過して後続処理へ進む（404 到達 = 認可は通った）」を固定する。

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
  handleApiError: vi.fn(
    (e: { status?: number; message?: string; code?: string }) =>
      Response.json(
        { error: { message: e?.message, code: e?.code } },
        { status: e?.status ?? 500 },
      ),
  ),
}));
vi.mock("@/lib/permissions", () => ({
  hasPermission: vi.fn(),
  maskValue: vi.fn((v: string | null) => v),
  hasExplicitWritePerm: vi.fn(() => true),
}));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/display-level", () => ({ applyDisplayToOwner: vi.fn() }));
vi.mock("@/lib/storage", () => ({ getStorage: vi.fn() }));
vi.mock("@/lib/storage/url-to-key", () => ({
  extractStorageKeyFromUrl: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  default: {
    property: { findUnique: vi.fn(), findMany: vi.fn(), delete: vi.fn() },
    building: { findUnique: vi.fn(), delete: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import prisma from "@/lib/prisma";
import { DELETE as deleteProperty } from "@/app/api/properties/[id]/route";
import { DELETE as deleteBuilding } from "@/app/api/buildings/[id]/route";

/** 指定した resource:action の組み合わせだけを許可する hasPermission mock。 */
function grantOnly(granted: Array<[string, string]>) {
  (hasPermission as unknown as Mock).mockImplementation(
    (_perms: unknown, resource: string, action: string) =>
      granted.some(([r, a]) => r === resource && a === action),
  );
}

const req = new Request("http://localhost/x") as never;

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({
    id: "user-1",
    role: "office_staff",
  });
  (getUserPermissions as Mock).mockResolvedValue([]);
});

describe("DELETE /api/properties/[id] — property:delete を要求する", () => {
  it("write はあるが delete が無いユーザーは 403 で、prisma に一切触れない", async () => {
    grantOnly([
      ["property", "read"],
      ["property", "write"],
    ]);

    const res = await deleteProperty(req, {
      params: Promise.resolve({ id: "prop-1" }),
    });

    expect(res.status).toBe(403);
    expect(
      (prisma.property.findUnique as unknown as Mock).mock.calls.length,
    ).toBe(0);
    expect((prisma.$transaction as unknown as Mock).mock.calls.length).toBe(0);
  });

  it("delete があれば認可を通過し、後続の存在確認まで進む", async () => {
    grantOnly([
      ["property", "read"],
      ["property", "write"],
      ["property", "delete"],
    ]);
    (prisma.property.findUnique as unknown as Mock).mockResolvedValue(null);

    const res = await deleteProperty(req, {
      params: Promise.resolve({ id: "prop-1" }),
    });

    // 認可は通り、存在しない物件なので 404（403 ではない）。
    expect(res.status).toBe(404);
    expect(
      (prisma.property.findUnique as unknown as Mock).mock.calls.length,
    ).toBe(1);
  });
});

describe("DELETE /api/buildings/[id] — property:delete を要求する", () => {
  it("write はあるが delete が無いユーザーは 403 で、prisma に一切触れない", async () => {
    grantOnly([
      ["property", "read"],
      ["property", "write"],
    ]);

    const res = await deleteBuilding(req, {
      params: Promise.resolve({ id: "bldg-1" }),
    });

    expect(res.status).toBe(403);
    expect(
      (prisma.building.findUnique as unknown as Mock).mock.calls.length,
    ).toBe(0);
  });

  it("delete があれば認可を通過し、後続の存在確認まで進む", async () => {
    grantOnly([
      ["property", "read"],
      ["property", "write"],
      ["property", "delete"],
    ]);
    (prisma.building.findUnique as unknown as Mock).mockResolvedValue(null);

    const res = await deleteBuilding(req, {
      params: Promise.resolve({ id: "bldg-1" }),
    });

    expect(res.status).toBe(404);
    expect(
      (prisma.building.findUnique as unknown as Mock).mock.calls.length,
    ).toBe(1);
  });
});
