/**
 * GET /api/properties(一覧)の 問い合わせ者・除外申請(2026-10-24 従業員の指摘 第2弾)。
 * - 問い合わせ者は個人情報: owner:read が無ければキーごと返さない・ある人は所有者の氏名と同じ表示レベル。
 * - 除外申請の札に使う状態・申請した日("YYYY-MM-DD")を返す。
 * - 「除外申請」の絞り込み(一覧と CSV が共有する property-list-query)。7日以上は JST の今日で判定。
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {
    nextUrl: URL;
    constructor(input: string | URL | Request, init?: RequestInit) {
      super(input, init);
      this.nextUrl = new URL(typeof input === "string" ? input : (input as Request).url);
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
    getOwnerDisplayConfig: vi.fn(),
    handleApiError: vi.fn((error: unknown) => {
      if (error instanceof MockApiError) {
        return Response.json({ error: { message: error.message, code: error.code } }, { status: error.status });
      }
      return Response.json({ error: { message: String(error), code: "INTERNAL_ERROR" } }, { status: 500 });
    }),
    apiResponse: vi.fn((data: unknown, status = 200) => Response.json(data, { status })),
  };
});

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  default: {
    property: { findMany: vi.fn(), count: vi.fn() },
    importJobRow: { findMany: vi.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { GET } from "../../app/api/properties/route";

const pm = prisma as unknown as { property: { findMany: Mock; count: Mock } };

const PERMS_OWNER = [
  { resource: "property", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
];
const PERMS_NO_OWNER = [{ resource: "property", action: "read", granted: true }];

function req(qs = "") {
  return new Request(`http://localhost/api/properties${qs}`) as unknown as import("next/server").NextRequest;
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: "p1",
    propertyType: "land",
    address: "東京都目黒区1-1",
    buildingName: null,
    lotNumber: null,
    buildingNumber: null,
    realEstateNumber: null,
    registryStatus: "unconfirmed",
    dmStatus: "hold",
    caseStatus: "contacting_owner",
    contractPlannedOn: null,
    settlementPlannedOn: null,
    introductionRoute: "bulk_assessment",
    inquirerName: "山田花子様",
    leadExclusionStatus: "requested",
    leadExclusionRequestedAt: new Date("2026-10-17T00:00:00.000Z"),
    isArchived: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    assignedTo: null,
    gpsLat: null,
    gpsLng: null,
    investigationConfirmedAt: null,
    assignee: null,
    propertyOwners: [{ owner: { name: "山田太郎" } }],
    _count: { dmLogs: 0 },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApiSession).mockResolvedValue({ id: "u1", email: "a@a", name: "A", role: "admin" } as never);
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS_OWNER as never);
  vi.mocked(getOwnerDisplayConfig).mockResolvedValue({ name: "full" } as never);
  pm.property.findMany.mockResolvedValue([row()]);
  pm.property.count.mockResolvedValue(1);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/properties — 問い合わせ者", () => {
  it("select に問い合わせ者・除外申請の状態・申請した日を含める", async () => {
    await GET(req());
    const select = pm.property.findMany.mock.calls[0][0].select;
    expect(select.inquirerName).toBe(true);
    expect(select.leadExclusionStatus).toBe(true);
    expect(select.leadExclusionRequestedAt).toBe(true);
  });

  it("owner:read あり・表示レベル full → そのまま返す", async () => {
    const body = await (await GET(req())).json();
    expect(body.data[0].inquirerName).toBe("山田花子様");
    expect(body.data[0].ownerNames).toEqual(["山田太郎"]);
  });

  it("表示レベル partial → 所有者の氏名と同じく伏せる", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValue({ name: "partial" } as never);
    const body = await (await GET(req())).json();
    expect(body.data[0].inquirerName).toBe("山田花***");
  });

  it("owner:read なし → キーごと返さない(所有者名も空)", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_NO_OWNER as never);
    const body = await (await GET(req())).json();
    expect(body.data[0]).not.toHaveProperty("inquirerName");
    expect(body.data[0].ownerNames).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("山田花子");
  });

  it("申請した日は YYYY-MM-DD で返す", async () => {
    const body = await (await GET(req())).json();
    expect(body.data[0].leadExclusionStatus).toBe("requested");
    expect(body.data[0].leadExclusionRequestedAt).toBe("2026-10-17");
  });

  it("監査ログに氏名を入れない", async () => {
    await GET(req());
    expect(JSON.stringify(vi.mocked(writeAuditLog).mock.calls)).not.toContain("山田花子");
  });
});

describe("GET /api/properties — 除外申請の絞り込み", () => {
  const whereOf = () => pm.property.findMany.mock.calls[0][0].where;

  it("未指定・空=絞らない", async () => {
    await GET(req("?leadExclusion="));
    expect(JSON.stringify(whereOf())).not.toContain("leadExclusion");
  });

  it("申請中・除外された・認められなかった=状態で AND", async () => {
    for (const v of ["requested", "approved", "rejected"]) {
      pm.property.findMany.mockClear();
      await GET(req(`?leadExclusion=${v}`));
      expect(whereOf().AND).toContainEqual({ leadExclusionStatus: v });
    }
  });

  it("申請中で7日以上: JST の今日から7日前以前(JST の日付の切り替わりで1日ずれる)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-24T14:59:59.000Z")); // JST 10/24 23:59:59
    await GET(req("?leadExclusion=requested_overdue"));
    expect(whereOf().AND).toContainEqual({
      leadExclusionStatus: "requested",
      leadExclusionRequestedAt: { lte: new Date("2026-10-17T00:00:00.000Z") },
    });
    pm.property.findMany.mockClear();
    vi.setSystemTime(new Date("2026-10-24T15:00:00.000Z")); // JST 10/25 0:00
    await GET(req("?leadExclusion=requested_overdue"));
    expect(whereOf().AND).toContainEqual({
      leadExclusionStatus: "requested",
      leadExclusionRequestedAt: { lte: new Date("2026-10-18T00:00:00.000Z") },
    });
  });

  it("keyword の OR と混ぜない(AND に足す)", async () => {
    await GET(req("?leadExclusion=requested&keyword=目黒"));
    const w = whereOf();
    expect(w.OR).toBeDefined();
    expect(JSON.stringify(w.OR)).not.toContain("leadExclusion");
    expect(w.AND).toContainEqual({ leadExclusionStatus: "requested" });
  });

  it("知らない値は 400 系で断る(zod)", async () => {
    const res = await GET(req("?leadExclusion=bogus"));
    expect(res.status).not.toBe(200);
    expect(pm.property.findMany).not.toHaveBeenCalled();
  });
});
