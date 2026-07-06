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
    getUserPermissions: vi.fn(),
    handleApiError: vi.fn((error: unknown) => {
      const e = error as { status?: number; message?: string; code?: string };
      return Response.json(
        { error: { message: e.message, code: e.code } },
        { status: typeof e.status === "number" ? e.status : 500 },
      );
    }),
    apiResponse: vi.fn((data: unknown, status = 200) => Response.json(data, { status })),
  };
});
vi.mock("@/lib/prisma", () => ({
  default: { fieldSurveyPin: { findMany: vi.fn() } },
}));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { GET } from "../route";

const pm = prisma as unknown as { fieldSurveyPin: { findMany: Mock } };
const READ = [{ resource: "field_survey", action: "read", granted: true }];
const READ_ALL = [
  { resource: "field_survey", action: "read", granted: true },
  { resource: "field_survey", action: "read_all", granted: true },
];

describe("GET /api/field-survey/pins/candidates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getApiSession as Mock).mockResolvedValue({ id: "user-1", role: "office_staff" });
    (getUserPermissions as Mock).mockResolvedValue(READ_ALL);
    pm.fieldSurveyPin.findMany.mockResolvedValue([]);
  });

  it("field_survey:read が無ければ 403", async () => {
    (getUserPermissions as Mock).mockResolvedValue([]);
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it("候補 × open × 未紐付けのみ・read_all は全スタッフ分を対象", async () => {
    await GET();
    const where = pm.fieldSurveyPin.findMany.mock.calls[0][0].where;
    expect(where.pinType).toBe("candidate");
    expect(where.status).toBe("open");
    expect(where.propertyId).toBeNull();
    expect(where.staffUserId).toBeUndefined();
  });

  it("read_all/manage が無ければ own のみ(staffUserId 強制)", async () => {
    (getUserPermissions as Mock).mockResolvedValue(READ);
    await GET();
    const where = pm.fieldSurveyPin.findMany.mock.calls[0][0].where;
    expect(where.staffUserId).toBe("user-1");
  });

  it("座標・memo 本文を返さず hasMemo のみ(非PII)", async () => {
    pm.fieldSurveyPin.findMany.mockResolvedValue([
      { id: "p1", staffUserId: "u", createdAt: "2026-07-06T00:00:00Z", memo: "秘密メモ" },
      { id: "p2", staffUserId: "u", createdAt: "2026-07-06T00:00:00Z", memo: "  " },
    ]);
    const res = await GET();
    const body = await res.json();
    expect(body.data[0]).toEqual({ id: "p1", staffUserId: "u", createdAt: "2026-07-06T00:00:00Z", hasMemo: true });
    expect(body.data[1].hasMemo).toBe(false);
    expect(body.data[0]).not.toHaveProperty("lat");
    expect(body.data[0]).not.toHaveProperty("memo");
    const select = pm.fieldSurveyPin.findMany.mock.calls[0][0].select;
    expect(select.lat).toBeUndefined();
    expect(select.lng).toBeUndefined();
  });
});
