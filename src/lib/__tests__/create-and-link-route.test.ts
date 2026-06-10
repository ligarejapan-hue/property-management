/**
 * POST /api/properties/[id]/owners/create-and-link route tests（Codex P1: orphan 防止）。
 *
 * - owner 作成 + PropertyOwner link 作成を 1 つの $transaction 内で atomic に行う。
 * - link 作成が失敗したら transaction 全体が reject（owner だけ残らない）。
 * - 既存 /api/owners POST 同等の権限ゲート・重複判定を経てから transaction に入る。
 *
 * route テストの mock 流儀は property-owner-link-route.test.ts に揃える（prisma mock + $transaction）。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {
    constructor(input: string | URL | Request, init?: RequestInit) {
      super(input, init);
    }
  }
  return { NextRequest: MockNextRequest };
});

vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn().mockResolvedValue({
      id: "user-1",
      email: "admin@test.com",
      name: "Admin",
      role: "admin",
    }),
    getUserPermissions: vi.fn(),
    handleApiError: vi.fn((error: unknown) => {
      if (error instanceof MockApiError) {
        return Response.json(
          { error: { message: error.message, code: error.code } },
          { status: error.status },
        );
      }
      return Response.json(
        { error: { message: "Server error", code: "INTERNAL_ERROR" } },
        { status: 500 },
      );
    }),
    apiResponse: vi.fn((data: unknown, status = 200) =>
      Response.json(data, { status }),
    ),
  };
});

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

vi.mock("@/lib/prisma", () => {
  const tx = {
    owner: { create: vi.fn() },
    propertyOwner: { updateMany: vi.fn(), create: vi.fn() },
  };
  return {
    default: {
      property: { findUnique: vi.fn() },
      // top-level owner.create は使わない（owner 作成は必ず tx 経由）= orphan 検証用に置く
      owner: { findMany: vi.fn(), create: vi.fn() },
      $transaction: vi
        .fn()
        .mockImplementation((fn: (tx: unknown) => unknown) => fn(tx)),
      _tx: tx,
    },
  };
});

import prisma from "@/lib/prisma";
import { getUserPermissions } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { POST } from "../../app/api/properties/[id]/owners/create-and-link/route";

const PROPERTY_ID = "11111111-1111-4111-8111-111111111111";

const pm = prisma as unknown as {
  property: { findUnique: Mock };
  owner: { findMany: Mock; create: Mock };
  $transaction: Mock;
  _tx: {
    owner: { create: Mock };
    propertyOwner: { updateMany: Mock; create: Mock };
  };
};

function makeRequest(body: unknown) {
  return new Request(
    `http://localhost/api/properties/${PROPERTY_ID}/owners/create-and-link`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  ) as unknown as import("next/server").NextRequest;
}

const makeParams = () => ({ params: Promise.resolve({ id: PROPERTY_ID }) });

beforeEach(() => {
  vi.clearAllMocks();
  pm.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(pm._tx),
  );
  pm.property.findUnique.mockResolvedValue({ id: PROPERTY_ID });
  pm.owner.findMany.mockResolvedValue([]);
  (getUserPermissions as Mock).mockResolvedValue([
    { resource: "owner", action: "write", granted: true },
    { resource: "owner_name", action: "full", granted: true },
    { resource: "owner_phone", action: "full", granted: true },
    { resource: "owner_address", action: "full", granted: true },
  ]);
});

describe("POST /api/properties/[id]/owners/create-and-link — atomic create + link", () => {
  it("成功: owner.create と propertyOwner.create が同一 $transaction 内で呼ばれる（201）", async () => {
    pm._tx.owner.create.mockResolvedValue({ id: "owner-new", name: "山田太郎" });
    pm._tx.propertyOwner.create.mockResolvedValue({
      id: "po-1",
      propertyId: PROPERTY_ID,
      ownerId: "owner-new",
      isPrimary: true,
    });

    const res = await POST(
      makeRequest({ name: "山田太郎", isPrimary: true }),
      makeParams(),
    );
    expect(res.status).toBe(201);
    expect(pm.$transaction).toHaveBeenCalledTimes(1);
    expect(pm._tx.owner.create).toHaveBeenCalledTimes(1);
    expect(pm._tx.propertyOwner.create).toHaveBeenCalledTimes(1);
    // owner 作成は transaction 経由のみ（top-level owner.create は使わない）
    expect(pm.owner.create).not.toHaveBeenCalled();
  });

  it("orphan 防止: link 作成が失敗すると transaction 全体が reject（owner だけ残らない）", async () => {
    pm._tx.owner.create.mockResolvedValue({ id: "owner-new", name: "山田太郎" });
    pm._tx.propertyOwner.create.mockRejectedValue(new Error("link failed"));

    const res = await POST(makeRequest({ name: "山田太郎" }), makeParams());
    expect(res.status).toBe(500);
    // owner 作成は tx 内のみ（DB は rollback）。top-level owner.create は呼ばれない
    expect(pm.owner.create).not.toHaveBeenCalled();
    // 両方とも同一 $transaction 内で試行された
    expect(pm.$transaction).toHaveBeenCalledTimes(1);
    expect(pm._tx.owner.create).toHaveBeenCalledTimes(1);
  });

  it("property が無ければ 404・$transaction に入らない（owner 作成しない）", async () => {
    pm.property.findUnique.mockResolvedValue(null);
    const res = await POST(makeRequest({ name: "山田太郎" }), makeParams());
    expect(res.status).toBe(404);
    expect(pm.$transaction).not.toHaveBeenCalled();
    expect(pm._tx.owner.create).not.toHaveBeenCalled();
  });

  it("重複（氏名+住所一致）なら 409・$transaction に入らない", async () => {
    pm.owner.findMany.mockResolvedValue([
      { id: "dup-1", name: "山田太郎", address: "東京都千代田区1-1" },
    ]);
    const res = await POST(
      makeRequest({ name: "山田太郎", address: "東京都千代田区1-1" }),
      makeParams(),
    );
    expect(res.status).toBe(409);
    expect(pm.$transaction).not.toHaveBeenCalled();
  });

  it("owner:write が無ければ 403（atomic 操作に入らない）", async () => {
    (getUserPermissions as Mock).mockResolvedValueOnce([]);
    const res = await POST(makeRequest({ name: "山田太郎" }), makeParams());
    expect(res.status).toBe(403);
    expect(pm.$transaction).not.toHaveBeenCalled();
  });

  it("isPrimary=true なら link 作成前に既存 primary を解除する", async () => {
    pm._tx.owner.create.mockResolvedValue({ id: "owner-new", name: "山田太郎" });
    pm._tx.propertyOwner.create.mockResolvedValue({ id: "po-1" });
    await POST(makeRequest({ name: "山田太郎", isPrimary: true }), makeParams());
    expect(pm._tx.propertyOwner.updateMany).toHaveBeenCalledWith({
      where: { propertyId: PROPERTY_ID, isPrimary: true },
      data: { isPrimary: false },
    });
  });

  it("AuditLog(owners): 生の owner PII（氏名/住所/電話）を detail に含めない・非PII識別子のみ", async () => {
    pm._tx.owner.create.mockResolvedValue({ id: "owner-new", name: "山田太郎" });
    pm._tx.propertyOwner.create.mockResolvedValue({ id: "po-1" });
    await POST(
      makeRequest({
        name: "山田太郎",
        phone: "090-1234-5678",
        address: "東京都千代田区1-1",
      }),
      makeParams(),
    );
    const ownerAudit = (writeAuditLog as Mock).mock.calls
      .map((c) => c[0] as { targetTable?: string; targetId?: string; detail?: Record<string, unknown> })
      .find((a) => a.targetTable === "owners");
    expect(ownerAudit).toBeTruthy();
    const detailStr = JSON.stringify(ownerAudit!.detail ?? {});
    // 生 PII（氏名/住所/電話）が detail に現れない
    expect(detailStr).not.toContain("山田太郎");
    expect(detailStr).not.toContain("東京都千代田区");
    expect(detailStr).not.toContain("090-1234-5678");
    // raw name キーを持たない
    expect(ownerAudit!.detail).not.toHaveProperty("name");
    // 追跡に必要な非PII（識別子・件数・状態）は残る（owner は targetId の UUID で特定）
    expect(ownerAudit!.targetId).toBe("owner-new");
    expect(ownerAudit!.detail).toMatchObject({
      createdOwner: true,
      propertyId: PROPERTY_ID,
    });
    expect(typeof ownerAudit!.detail!.fieldCount).toBe("number");
  });

  it("AuditLog(property_owners): propertyId / ownerId(UUID) 等の非PIIのみ（生氏名なし）", async () => {
    pm._tx.owner.create.mockResolvedValue({ id: "owner-new", name: "山田太郎" });
    pm._tx.propertyOwner.create.mockResolvedValue({ id: "po-1" });
    await POST(makeRequest({ name: "山田太郎" }), makeParams());
    const linkAudit = (writeAuditLog as Mock).mock.calls
      .map((c) => c[0] as { targetTable?: string; detail?: Record<string, unknown> })
      .find((a) => a.targetTable === "property_owners");
    expect(linkAudit).toBeTruthy();
    expect(JSON.stringify(linkAudit!.detail ?? {})).not.toContain("山田太郎");
    expect(linkAudit!.detail).toMatchObject({
      propertyId: PROPERTY_ID,
      ownerId: "owner-new",
    });
  });
});
