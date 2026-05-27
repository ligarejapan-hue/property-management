/**
 * /api/field-survey/map/properties route tests (Phase 1-D).
 *
 * - 権限: field_survey:read + property:read 両方必須
 * - field_staff の createdBy/assignedTo scope 強制 (既存 /api/properties と整合)
 * - bbox validation: 範囲外 / north<south / east<west / 面積超過は 422
 * - gpsLat/gpsLng null の Property は返らない (where で除外)
 * - response: 地図表示用の最小フィールドのみ。owner PII / rawData / memo を含まない
 * - cursor pagination: take=limit+1, nextCursor 判定
 * - AuditLog: 高頻度 endpoint のため書かない
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
    getApiSession: vi.fn(),
    getUserPermissions: vi.fn(),
    handleApiError: vi.fn((error: unknown) => {
      if (error instanceof MockApiError) {
        return Response.json(
          { error: { message: error.message, code: error.code } },
          { status: error.status },
        );
      }
      if (
        error &&
        typeof error === "object" &&
        "issues" in error &&
        Array.isArray((error as { issues: unknown[] }).issues)
      ) {
        return Response.json(
          { error: { message: "validation", code: "VALIDATION_ERROR" } },
          { status: 422 },
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

const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));

vi.mock("@/lib/prisma", () => ({
  default: {
    property: {
      findMany: vi.fn(),
    },
  },
}));

import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
} from "@/lib/api-helpers";
import { GET } from "@/app/api/field-survey/map/properties/route";

const fieldUser = { id: "u-field", email: "f@x", name: "F", role: "field_staff" };
const officeUser = { id: "u-office", email: "o@x", name: "O", role: "office_staff" };
const adminUser = { id: "u-admin", email: "a@x", name: "A", role: "admin" };

const fieldSurveyOnly = [
  { resource: "field_survey", action: "read", granted: true },
];
const fieldSurveyAndPropRead = [
  { resource: "field_survey", action: "read", granted: true },
  { resource: "property", action: "read", granted: true },
];
const propReadOnly = [
  { resource: "property", action: "read", granted: true },
];

const BASE_BBOX = "north=35.7&south=35.6&east=139.8&west=139.7";

beforeEach(() => {
  vi.clearAllMocks();
});

function makeReq(qs: string) {
  return new Request(
    `http://x/api/field-survey/map/properties?${qs}`,
  ) as unknown as import("next/server").NextRequest;
}

function buildProperty(overrides: Partial<{
  id: string;
  gpsLat: number;
  gpsLng: number;
  address: string;
  updatedAt: Date;
}> = {}) {
  return {
    id: overrides.id ?? "p-1",
    address: overrides.address ?? "東京都千代田区...",
    gpsLat: overrides.gpsLat ?? 35.68,
    gpsLng: overrides.gpsLng ?? 139.75,
    propertyType: "land",
    registryStatus: "unconfirmed",
    dmStatus: "hold",
    caseStatus: "new_case",
    updatedAt: overrides.updatedAt ?? new Date(),
  };
}

describe("GET /api/field-survey/map/properties", () => {
  // ---------- 権限 ----------

  it("未ログインは 401", async () => {
    (getApiSession as Mock).mockRejectedValueOnce(
      new ApiError(401, "認証が必要です", "UNAUTHORIZED"),
    );
    const res = await GET(makeReq(BASE_BBOX));
    expect(res.status).toBe(401);
  });

  it("field_survey:read 不所持は 403", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(propReadOnly);
    const res = await GET(makeReq(BASE_BBOX));
    expect(res.status).toBe(403);
    expect(prisma.property.findMany).not.toHaveBeenCalled();
  });

  it("property:read 不所持は 403", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldSurveyOnly);
    const res = await GET(makeReq(BASE_BBOX));
    expect(res.status).toBe(403);
    expect(prisma.property.findMany).not.toHaveBeenCalled();
  });

  // ---------- bbox validation ----------

  it("bbox 未指定 (north 欠落) は 422", async () => {
    (getApiSession as Mock).mockResolvedValue(adminUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldSurveyAndPropRead);
    const res = await GET(makeReq("south=35.6&east=139.8&west=139.7"));
    expect(res.status).toBe(422);
    expect(prisma.property.findMany).not.toHaveBeenCalled();
  });

  it("north < south は 422", async () => {
    (getApiSession as Mock).mockResolvedValue(adminUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldSurveyAndPropRead);
    const res = await GET(
      makeReq("north=35.5&south=35.7&east=139.8&west=139.7"),
    );
    expect(res.status).toBe(422);
  });

  it("east < west は 422 (日付変更線跨ぎは非対応)", async () => {
    (getApiSession as Mock).mockResolvedValue(adminUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldSurveyAndPropRead);
    const res = await GET(
      makeReq("north=35.7&south=35.6&east=139.7&west=139.8"),
    );
    expect(res.status).toBe(422);
  });

  it("緯度差 > 0.5 度は 422", async () => {
    (getApiSession as Mock).mockResolvedValue(adminUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldSurveyAndPropRead);
    const res = await GET(
      makeReq("north=36.5&south=35.6&east=139.8&west=139.7"),
    );
    expect(res.status).toBe(422);
  });

  it("経度差 > 0.5 度は 422", async () => {
    (getApiSession as Mock).mockResolvedValue(adminUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldSurveyAndPropRead);
    const res = await GET(
      makeReq("north=35.7&south=35.6&east=140.5&west=139.7"),
    );
    expect(res.status).toBe(422);
  });

  it("lat/lng 範囲外 (north=91) は 422", async () => {
    (getApiSession as Mock).mockResolvedValue(adminUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldSurveyAndPropRead);
    const res = await GET(
      makeReq("north=91&south=35.6&east=139.8&west=139.7"),
    );
    expect(res.status).toBe(422);
  });

  // ---------- where 構築 ----------

  it("gpsLat/gpsLng null を除外する where が組まれる", async () => {
    (getApiSession as Mock).mockResolvedValue(adminUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldSurveyAndPropRead);
    (prisma.property.findMany as Mock).mockResolvedValue([]);
    await GET(makeReq(BASE_BBOX));
    const args = (prisma.property.findMany as Mock).mock.calls[0][0];
    expect(args.where.gpsLat).toEqual({ gte: 35.6, lte: 35.7, not: null });
    expect(args.where.gpsLng).toEqual({ gte: 139.7, lte: 139.8, not: null });
  });

  it("デフォルトで isArchived=false (includeArchived=false)", async () => {
    (getApiSession as Mock).mockResolvedValue(adminUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldSurveyAndPropRead);
    (prisma.property.findMany as Mock).mockResolvedValue([]);
    await GET(makeReq(BASE_BBOX));
    const args = (prisma.property.findMany as Mock).mock.calls[0][0];
    expect(args.where.isArchived).toBe(false);
  });

  it("includeArchived=true で isArchived 条件を外す", async () => {
    (getApiSession as Mock).mockResolvedValue(adminUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldSurveyAndPropRead);
    (prisma.property.findMany as Mock).mockResolvedValue([]);
    await GET(makeReq(`${BASE_BBOX}&includeArchived=true`));
    const args = (prisma.property.findMany as Mock).mock.calls[0][0];
    expect(args.where.isArchived).toBeUndefined();
  });

  // ---------- field_staff scope ----------

  it("field_staff は createdBy/assignedTo の AND scope を強制", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldSurveyAndPropRead);
    (prisma.property.findMany as Mock).mockResolvedValue([]);
    await GET(makeReq(BASE_BBOX));
    const args = (prisma.property.findMany as Mock).mock.calls[0][0];
    expect(args.where.AND).toEqual([
      {
        OR: [
          { createdBy: fieldUser.id },
          { assignedTo: fieldUser.id },
        ],
      },
    ]);
  });

  it("office_staff は scope 強制なし", async () => {
    (getApiSession as Mock).mockResolvedValue(officeUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldSurveyAndPropRead);
    (prisma.property.findMany as Mock).mockResolvedValue([]);
    await GET(makeReq(BASE_BBOX));
    const args = (prisma.property.findMany as Mock).mock.calls[0][0];
    expect(args.where.AND).toBeUndefined();
  });

  it("admin は scope 強制なし", async () => {
    (getApiSession as Mock).mockResolvedValue(adminUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldSurveyAndPropRead);
    (prisma.property.findMany as Mock).mockResolvedValue([]);
    await GET(makeReq(BASE_BBOX));
    const args = (prisma.property.findMany as Mock).mock.calls[0][0];
    expect(args.where.AND).toBeUndefined();
  });

  // ---------- pagination ----------

  it("limit が反映される (take=limit+1)", async () => {
    (getApiSession as Mock).mockResolvedValue(adminUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldSurveyAndPropRead);
    (prisma.property.findMany as Mock).mockResolvedValue([]);
    await GET(makeReq(`${BASE_BBOX}&limit=50`));
    const args = (prisma.property.findMany as Mock).mock.calls[0][0];
    expect(args.take).toBe(51);
  });

  it("limit 既定は 200 (take=201)", async () => {
    (getApiSession as Mock).mockResolvedValue(adminUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldSurveyAndPropRead);
    (prisma.property.findMany as Mock).mockResolvedValue([]);
    await GET(makeReq(BASE_BBOX));
    const args = (prisma.property.findMany as Mock).mock.calls[0][0];
    expect(args.take).toBe(201);
  });

  it("limit > 500 は 422", async () => {
    (getApiSession as Mock).mockResolvedValue(adminUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldSurveyAndPropRead);
    const res = await GET(makeReq(`${BASE_BBOX}&limit=501`));
    expect(res.status).toBe(422);
  });

  it("cursor 指定で skip:1 + cursor が渡る", async () => {
    (getApiSession as Mock).mockResolvedValue(adminUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldSurveyAndPropRead);
    (prisma.property.findMany as Mock).mockResolvedValue([]);
    const cur = "11111111-1111-4111-8111-111111111111";
    await GET(makeReq(`${BASE_BBOX}&cursor=${cur}`));
    const args = (prisma.property.findMany as Mock).mock.calls[0][0];
    expect(args.cursor).toEqual({ id: cur });
    expect(args.skip).toBe(1);
  });

  it("limit+1 件返ったら nextCursor を発行する", async () => {
    (getApiSession as Mock).mockResolvedValue(adminUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldSurveyAndPropRead);
    // limit=2 で 3 件返る → data 2 件 + nextCursor = 2 件目の id
    (prisma.property.findMany as Mock).mockResolvedValue([
      buildProperty({ id: "p-a" }),
      buildProperty({ id: "p-b" }),
      buildProperty({ id: "p-c" }),
    ]);
    const res = await GET(makeReq(`${BASE_BBOX}&limit=2`));
    const body = await res.json();
    expect(body.data.length).toBe(2);
    expect(body.nextCursor).toBe("p-b");
  });

  it("limit 以下の件数なら nextCursor は null", async () => {
    (getApiSession as Mock).mockResolvedValue(adminUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldSurveyAndPropRead);
    (prisma.property.findMany as Mock).mockResolvedValue([
      buildProperty({ id: "p-a" }),
    ]);
    const res = await GET(makeReq(`${BASE_BBOX}&limit=10`));
    const body = await res.json();
    expect(body.nextCursor).toBeNull();
  });

  // ---------- response shape (PII protection) ----------

  it("response に owner PII (propertyOwners / assignee) を含めない select", async () => {
    (getApiSession as Mock).mockResolvedValue(adminUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldSurveyAndPropRead);
    (prisma.property.findMany as Mock).mockResolvedValue([]);
    await GET(makeReq(BASE_BBOX));
    const args = (prisma.property.findMany as Mock).mock.calls[0][0];
    expect(args.select.propertyOwners).toBeUndefined();
    expect(args.select.assignee).toBeUndefined();
    expect(args.select.investigationConfirmedAt).toBeUndefined();
    // 地図用最小フィールドが含まれる
    expect(args.select.id).toBe(true);
    expect(args.select.address).toBe(true);
    expect(args.select.gpsLat).toBe(true);
    expect(args.select.gpsLng).toBe(true);
    expect(args.select.updatedAt).toBe(true);
  });

  it("response body に PII / rawData / memo を含めない (構造検査)", async () => {
    (getApiSession as Mock).mockResolvedValue(adminUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldSurveyAndPropRead);
    (prisma.property.findMany as Mock).mockResolvedValue([
      buildProperty({ id: "p-x", address: "東京都千代田区..." }),
    ]);
    const res = await GET(makeReq(BASE_BBOX));
    const body = await res.json();
    const row = body.data[0];
    expect(row).not.toHaveProperty("memo");
    expect(row).not.toHaveProperty("rawData");
    expect(row).not.toHaveProperty("rawPayloadJson");
    expect(row).not.toHaveProperty("propertyOwners");
    expect(row).not.toHaveProperty("assignee");
    expect(row).not.toHaveProperty("ownerName");
    expect(row.id).toBe("p-x");
    expect(row.gpsLat).toBeDefined();
    expect(row.gpsLng).toBeDefined();
  });

  // ---------- AuditLog ----------

  it("通常取得で AuditLog を書かない (高頻度 endpoint)", async () => {
    (getApiSession as Mock).mockResolvedValue(adminUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldSurveyAndPropRead);
    (prisma.property.findMany as Mock).mockResolvedValue([buildProperty()]);
    await GET(makeReq(BASE_BBOX));
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("422 エラー時も AuditLog / 詳細 raw query は書かない (情報漏洩防止)", async () => {
    (getApiSession as Mock).mockResolvedValue(adminUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldSurveyAndPropRead);
    const res = await GET(
      makeReq("north=35.5&south=35.7&east=139.8&west=139.7"),
    );
    expect(res.status).toBe(422);
    const text = await res.text();
    expect(text).not.toMatch(/35\.5/);
    expect(text).not.toMatch(/35\.7/);
    expect(text).not.toMatch(/139\.7/);
    expect(text).not.toMatch(/139\.8/);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("orderBy は [updatedAt desc, id desc]", async () => {
    (getApiSession as Mock).mockResolvedValue(adminUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldSurveyAndPropRead);
    (prisma.property.findMany as Mock).mockResolvedValue([]);
    await GET(makeReq(BASE_BBOX));
    const args = (prisma.property.findMany as Mock).mock.calls[0][0];
    expect(args.orderBy).toEqual([{ updatedAt: "desc" }, { id: "desc" }]);
  });
});
