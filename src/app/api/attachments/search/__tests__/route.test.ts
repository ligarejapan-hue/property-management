/**
 * GET /api/attachments/search — 添付横断検索（admin 限定・ISO-SAFE・schema 無改変）。
 *
 *  - admin 以外は 403 / 未認証は 401。
 *  - query: type / fileName(部分一致) / from・to(期間) / targetType・targetId。
 *  - 既定 isDeleted=false。
 *  - 返却はメタ（id/fileName/type/createdAt/targetType/targetId）のみ。
 *    **ファイル本体 URL(fileUrl)は select せず=結果に載せない**。
 *  - 非PII audit（検索語の生値は記録せず hasFileName 真偽のみ）。
 *
 * prisma / api-helpers / audit はモックして実 DB 非依存でテストする。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

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
    handleApiError: vi.fn((error: unknown) => {
      const e = error as { status?: number; message?: string; code?: string };
      if (typeof e?.status === "number") {
        return Response.json(
          { error: { message: e.message, code: e.code } },
          { status: e.status },
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

vi.mock("@/lib/prisma", () => ({
  default: { attachment: { findMany: vi.fn() } },
}));

import prisma from "@/lib/prisma";
import { getApiSession, ApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { GET } from "../route";

const pm = prisma as unknown as { attachment: { findMany: Mock } };
const mockedGetSession = getApiSession as unknown as Mock;
const mockedAudit = writeAuditLog as unknown as Mock;

const UUID = "11111111-1111-4111-8111-111111111111";

function req(qs = ""): Request {
  return new Request(`http://localhost/api/attachments/search${qs}`);
}

function lastWhere(): Record<string, unknown> {
  return (pm.attachment.findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> })
    .where;
}

describe("GET /api/attachments/search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetSession.mockResolvedValue({
      id: "admin-1",
      email: "a@a",
      name: "Admin",
      role: "admin",
    });
    pm.attachment.findMany.mockResolvedValue([]);
  });

  it("未認証は 401", async () => {
    mockedGetSession.mockRejectedValueOnce(
      new ApiError(401, "認証が必要です", "UNAUTHORIZED"),
    );

    const res = await GET(req());

    expect(res.status).toBe(401);
    expect(pm.attachment.findMany).not.toHaveBeenCalled();
  });

  it("admin 以外は 403（DB も audit も呼ばない）", async () => {
    mockedGetSession.mockResolvedValueOnce({
      id: "u2",
      email: "o@o",
      name: "Office",
      role: "office_staff",
    });

    const res = await GET(req());

    expect(res.status).toBe(403);
    expect(pm.attachment.findMany).not.toHaveBeenCalled();
    expect(mockedAudit).not.toHaveBeenCalled();
  });

  it("admin は 200・メタのみ返す（fileUrl を select せず結果に載せない）", async () => {
    pm.attachment.findMany.mockResolvedValueOnce([
      {
        id: "att-1",
        fileName: "謄本.pdf",
        type: "registry",
        createdAt: new Date("2026-02-01T00:00:00Z"),
        targetType: "property",
        targetId: UUID,
      },
    ]);

    const res = await GET(req());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).not.toHaveProperty("fileUrl");

    const call = pm.attachment.findMany.mock.calls[0][0];
    // select はメタ6項目のみ・fileUrl 非選択・include 不使用
    expect(call.select).toEqual({
      id: true,
      fileName: true,
      type: true,
      createdAt: true,
      targetType: true,
      targetId: true,
    });
    expect(call.select).not.toHaveProperty("fileUrl");
    expect(call).not.toHaveProperty("include");
    expect(call.orderBy).toEqual({ createdAt: "desc" });
    expect(typeof call.take).toBe("number");
    expect(call.take).toBeGreaterThan(0);
  });

  it("既定で isDeleted=false を where に含む", async () => {
    await GET(req());
    expect(lastWhere().isDeleted).toBe(false);
  });

  it("type / fileName / targetType / targetId / 期間 を where に反映", async () => {
    await GET(
      req(
        `?type=registry&fileName=foo&targetType=property&targetId=${UUID}&from=2026-01-01&to=2026-01-31`,
      ),
    );

    const where = lastWhere();
    expect(where.type).toBe("registry");
    expect(where.fileName).toEqual({ contains: "foo", mode: "insensitive" });
    expect(where.targetType).toBe("property");
    expect(where.targetId).toBe(UUID);
    const createdAt = where.createdAt as { gte: Date; lte: Date };
    expect(createdAt.gte).toBeInstanceOf(Date);
    expect(createdAt.lte).toBeInstanceOf(Date);
    expect(createdAt.lte.getTime()).toBeGreaterThan(createdAt.gte.getTime());
  });

  it("非PII audit：action=attachment_search・検索語の生値は記録しない", async () => {
    await GET(req(`?fileName=zzsecretterm`));

    expect(mockedAudit).toHaveBeenCalledTimes(1);
    const arg = mockedAudit.mock.calls[0][0];
    expect(arg.action).toBe("attachment_search");
    expect(arg.userId).toBe("admin-1");
    // 検索語の生値が audit detail に混入しない（PII 漏えい防止）
    expect(JSON.stringify(arg.detail)).not.toContain("zzsecretterm");
    expect(arg.detail.filters.hasFileName).toBe(true);
  });

  it("不正な query は 400（DB を呼ばない）", async () => {
    const res = await GET(req(`?type=bogus`));

    expect(res.status).toBe(400);
    expect(pm.attachment.findMany).not.toHaveBeenCalled();
  });
});
