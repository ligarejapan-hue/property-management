/**
 * DQ-03: 住所の登記文字列 cleanup の per-owner route（GET preview / POST apply）の安全ゲート検証。
 * 既存 corporate-cleanup route と同型: owner:write + owner_address field write・display raw-visible・
 * version 楽観ロック・監査専用は apply 不可・非PII 監査ログ。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
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
    getApiSession: vi.fn(),
    getUserPermissions: vi.fn(),
    getOwnerDisplayConfig: vi.fn(),
    handleApiError: vi.fn((error: unknown) => {
      const e = error as { status?: number; message?: string; code?: string };
      const status = typeof e?.status === "number" ? e.status : 500;
      return Response.json({ error: { message: e?.message, code: e?.code } }, { status });
    }),
    apiResponse: vi.fn((data: unknown, status = 200) =>
      Response.json(data as Record<string, unknown>, { status }),
    ),
  };
});

vi.mock("@/lib/permissions", () => ({
  hasPermission: vi.fn(),
  hasExplicitWritePerm: vi.fn(),
  maskValue: vi.fn((v: string | null) => v),
}));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/change-log", () => ({
  recordChanges: vi.fn(),
  OWNER_TRACKED_FIELDS: [],
}));
vi.mock("@/lib/prisma", () => ({
  default: {
    owner: { findUnique: vi.fn(), updateMany: vi.fn() },
  },
}));

import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
} from "@/lib/api-helpers";
import { hasPermission, hasExplicitWritePerm } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { POST, GET } from "@/app/api/admin/owners/[id]/registry-address-cleanup/route";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";

const pm = prisma as unknown as {
  owner: { findUnique: Mock; updateMany: Mock };
};

function setOwner(over: Record<string, unknown> = {}) {
  pm.owner.findUnique.mockResolvedValue({
    id: OWNER_ID,
    name: "山田太郎",
    address: "東京都港区六本木1-2-3 受付第12345号",
    note: null,
    version: 4,
    isArchived: false,
    ...over,
  });
}

function postReq(body: unknown) {
  return new Request(`http://t/api/admin/owners/${OWNER_ID}/registry-address-cleanup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}
const params = { params: Promise.resolve({ id: OWNER_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  setOwner();
  pm.owner.updateMany.mockResolvedValue({ count: 1 });
  (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Mock).mockResolvedValue([]);
  (getOwnerDisplayConfig as Mock).mockResolvedValue({
    name: "full",
    address: "full",
    note: "full",
    corporateNumber: "full",
  });
  (hasPermission as Mock).mockReturnValue(true);
  (hasExplicitWritePerm as Mock).mockReturnValue(true);
});

describe("POST apply（住所登記文字列 cleanup）", () => {
  it("成功: 受付番号を除去して address を更新（version+1）", async () => {
    const res = await POST(postReq({ version: 4, apply: { address: true } }), params);
    expect(res.status).toBe(200);
    expect(pm.owner.updateMany).toHaveBeenCalledTimes(1);
    const call = pm.owner.updateMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ id: OWNER_ID, version: 4 });
    expect(call.data.address).toBe("東京都港区六本木1-2-3");
    // 監査ログは非PII（住所本文を載せない）
    const audit = (writeAuditLog as Mock).mock.calls.find(
      (c) => c[0]?.action === "owner_registry_address_cleanup_apply",
    );
    expect(audit).toBeTruthy();
    expect(JSON.stringify(audit![0].detail)).not.toContain("六本木");
  });

  it("owner:write が無ければ 403・更新なし", async () => {
    (hasPermission as Mock).mockImplementation((_p, res: string, act: string) =>
      !(res === "owner" && act === "write"),
    );
    const res = await POST(postReq({ version: 4, apply: { address: true } }), params);
    expect(res.status).toBe(403);
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });

  it("owner_address の field write が無ければ 403・更新なし", async () => {
    (hasExplicitWritePerm as Mock).mockReturnValue(false);
    const res = await POST(postReq({ version: 4, apply: { address: true } }), params);
    expect(res.status).toBe(403);
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });

  it("address が raw-visible でない（masked）なら 403・更新なし", async () => {
    (getOwnerDisplayConfig as Mock).mockResolvedValue({
      name: "full",
      address: "masked",
      note: "full",
      corporateNumber: "full",
    });
    const res = await POST(postReq({ version: 4, apply: { address: true } }), params);
    expect(res.status).toBe(403);
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });

  it("監査専用のみ（除去対象なし）の owner は apply 不可（409）・更新なし", async () => {
    setOwner({ address: "東京都港区1-2 不動産番号1300012345678" });
    const res = await POST(postReq({ version: 4, apply: { address: true } }), params);
    expect(res.status).toBe(409);
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });

  it("version 競合（updateMany count=0）→ 409", async () => {
    pm.owner.updateMany.mockResolvedValue({ count: 0 });
    const res = await POST(postReq({ version: 4, apply: { address: true } }), params);
    expect(res.status).toBe(409);
  });

  it("apply.address=false（反映対象なし）→ 400・更新なし", async () => {
    const res = await POST(postReq({ version: 4, apply: { address: false } }), params);
    expect(res.status).toBe(400);
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });
});

describe("GET preview", () => {
  it("owner:read で before/after をマスクして返す（detectedTypes 含む）", async () => {
    const res = await GET(postReq({}), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cleanup.action).toBe("cleanup");
    expect(body.cleanup.detectedTypes).toContain("receipt_number");
    expect(body.cleanup.version).toBe(4);
  });
});
