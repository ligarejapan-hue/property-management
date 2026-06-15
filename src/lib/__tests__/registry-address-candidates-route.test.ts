/**
 * DQ-03: 住所登記文字列 candidates 一覧 route（dry-run）の field-visibility oracle ゲート検証。
 * corporate-number-candidates と同型: user_management:read / owner:read 必須、
 * 住所が raw-visible でなければ 403（oracle 漏れ防止）、氏名マスク、監査に住所本文を載せない。
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
  // maskValue: full のときは生値、それ以外はマスク（テスト用の簡易実装）。
  maskValue: vi.fn((v: string | null, level: string) =>
    v == null ? null : level === "full" ? v : "***",
  ),
}));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: { owner: { findMany: vi.fn() } },
}));

import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { GET } from "@/app/api/admin/owners/correction/registry-address-candidates/route";

const pm = prisma as unknown as { owner: { findMany: Mock } };

function req(qs = "") {
  return new Request(
    `http://t/api/admin/owners/correction/registry-address-candidates${qs}`,
    { method: "GET" },
  ) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Mock).mockResolvedValue([]);
  (getOwnerDisplayConfig as Mock).mockResolvedValue({
    name: "masked",
    address: "full",
    note: "full",
    corporateNumber: "full",
  });
  (hasPermission as Mock).mockReturnValue(true);
  pm.owner.findMany.mockResolvedValue([
    {
      id: "o1",
      name: "山田太郎",
      address: "東京都港区六本木1-2-3 受付第12345号",
      version: 2,
    },
  ]);
});

describe("GET registry-address-candidates（oracle ゲート）", () => {
  it("user_management:read 欠如 → 403", async () => {
    (hasPermission as Mock).mockImplementation(
      (_p, res: string) => res !== "user_management",
    );
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(pm.owner.findMany).not.toHaveBeenCalled();
  });

  it("owner:read 欠如 → 403", async () => {
    (hasPermission as Mock).mockImplementation(
      (_p, res: string) => res !== "owner",
    );
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(pm.owner.findMany).not.toHaveBeenCalled();
  });

  for (const level of ["masked", "partial", "hidden"] as const) {
    it(`住所が ${level}（raw-visible でない）→ 403（oracle ゲート・最重要）`, async () => {
      (getOwnerDisplayConfig as Mock).mockResolvedValue({
        name: "full",
        address: level,
        note: "full",
        corporateNumber: "full",
      });
      const res = await GET(req());
      expect(res.status).toBe(403);
      expect(pm.owner.findMany).not.toHaveBeenCalled();
    });
  }

  it("氏名は display-level に従ってマスクされる（name=masked → ***）", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0].ownerNameMasked).toBe("***");
  });

  it("監査ログに住所本文・氏名を載せない（件数/summary のみ）", async () => {
    await GET(req());
    const audit = (writeAuditLog as Mock).mock.calls.find(
      (c) => c[0]?.action === "owner_registry_address_candidates_list",
    );
    expect(audit).toBeTruthy();
    const json = JSON.stringify(audit![0].detail);
    expect(json).not.toContain("六本木");
    expect(json).not.toContain("山田太郎");
    expect(json).not.toContain("受付");
  });

  it("truncated / hasNextPage が surface される", async () => {
    const res = await GET(req());
    const body = await res.json();
    expect(typeof body.truncated).toBe("boolean");
    expect(typeof body.hasNextPage).toBe("boolean");
    expect(body.summary).toMatchObject({ total: 1, cleanup: 1 });
  });
});
