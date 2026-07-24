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
    apiResponse: vi.fn((data: unknown, status = 200) =>
      Response.json(data, { status }),
    ),
  };
});
vi.mock("@/lib/prisma", () => ({
  default: { fieldSurveyPin: { findUnique: vi.fn() } },
}));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { GET } from "../route";

const pm = prisma as unknown as {
  fieldSurveyPin: { findUnique: Mock };
};
const READ = [{ resource: "field_survey", action: "read", granted: true }];
const READ_ALL = [
  { resource: "field_survey", action: "read", granted: true },
  { resource: "field_survey", action: "read_all", granted: true },
];

// route は _request を使わないため素の Request で十分。
const req = () =>
  new Request("http://localhost/api/field-survey/pins/p1/location");
const params = Promise.resolve({ id: "p1" });

describe("GET /api/field-survey/pins/[id]/location", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getApiSession as Mock).mockResolvedValue({ id: "user-1" });
    (getUserPermissions as Mock).mockResolvedValue(READ);
  });

  it("field_survey:read が無ければ 403", async () => {
    (getUserPermissions as Mock).mockResolvedValue([]);
    const res = await GET(req() as never, { params });
    expect(res.status).toBe(403);
  });

  it("own pin: lat/lng のみ返し memo/staffUserId は返さない・監査しない", async () => {
    pm.fieldSurveyPin.findUnique.mockResolvedValue({
      id: "p1",
      staffUserId: "user-1",
      lat: 35.1,
      lng: 139.2,
    });
    const res = await GET(req() as never, { params });
    const body = await res.json();
    expect(body.data).toEqual({ lat: 35.1, lng: 139.2 });
    expect(body.data).not.toHaveProperty("memo");
    expect(body.data).not.toHaveProperty("staffUserId");
    // select に memo を含めない (生 memo を client に乗せない)
    const select = pm.fieldSurveyPin.findUnique.mock.calls[0][0].select;
    expect(select.memo).toBeUndefined();
    expect(select.lat).toBe(true);
    // own は監査しない
    expect(writeAuditLog as Mock).not.toHaveBeenCalled();
  });

  it("他人 pin: read_all があれば座標を返し field_survey_pin_view を監査 (座標は detail に入れない)", async () => {
    (getUserPermissions as Mock).mockResolvedValue(READ_ALL);
    pm.fieldSurveyPin.findUnique.mockResolvedValue({
      id: "p1",
      staffUserId: "other",
      lat: 35.1,
      lng: 139.2,
    });
    const res = await GET(req() as never, { params });
    const body = await res.json();
    expect(body.data).toEqual({ lat: 35.1, lng: 139.2 });
    expect(writeAuditLog as Mock).toHaveBeenCalledTimes(1);
    const detail = (writeAuditLog as Mock).mock.calls[0][0].detail;
    expect(detail).not.toHaveProperty("lat");
    expect(detail).not.toHaveProperty("lng");
    expect(detail).not.toHaveProperty("memo");
  });

  it("他人 pin: read_all/manage 無しは 403", async () => {
    pm.fieldSurveyPin.findUnique.mockResolvedValue({
      id: "p1",
      staffUserId: "other",
      lat: 35.1,
      lng: 139.2,
    });
    const res = await GET(req() as never, { params });
    expect(res.status).toBe(403);
  });

  it("存在しない pin は 404", async () => {
    pm.fieldSurveyPin.findUnique.mockResolvedValue(null);
    const res = await GET(req() as never, { params });
    expect(res.status).toBe(404);
  });
});
