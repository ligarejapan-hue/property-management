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
    parseJsonBody: vi.fn(async (req: Request) => req.json()),
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
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: {
    fieldSurveyPin: { findUnique: vi.fn(), updateMany: vi.fn() },
    property: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { POST } from "../route";

const pm = prisma as unknown as {
  fieldSurveyPin: { findUnique: Mock; updateMany: Mock };
  property: { create: Mock };
  $transaction: Mock;
};
const WRITE = [{ resource: "property", action: "write", granted: true }];
const WRITE_MANAGE = [
  { resource: "property", action: "write", granted: true },
  { resource: "field_survey", action: "manage", granted: true },
];
const WRITE_READ_ALL = [
  { resource: "property", action: "write", granted: true },
  { resource: "field_survey", action: "read_all", granted: true },
];
const PIN_ID = "11111111-1111-1111-1111-111111111111";

function req(body: unknown) {
  return new Request(
    `http://localhost/api/field-survey/pins/${PIN_ID}/convert-to-property`,
    { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } },
  ) as unknown as import("next/server").NextRequest;
}
const ctx = { params: Promise.resolve({ id: PIN_ID }) };

function candidatePin(overrides: Record<string, unknown> = {}) {
  return {
    id: PIN_ID,
    staffUserId: "user-1",
    propertyId: null,
    pinType: "candidate",
    lat: 35.5,
    lng: 139.5,
    status: "open",
    ...overrides,
  };
}

describe("POST /api/field-survey/pins/[id]/convert-to-property", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getApiSession as Mock).mockResolvedValue({ id: "user-1", role: "member" });
    (getUserPermissions as Mock).mockResolvedValue(WRITE);
    pm.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({ property: { create: pm.property.create }, fieldSurveyPin: { updateMany: pm.fieldSurveyPin.updateMany } }),
    );
    pm.property.create.mockResolvedValue({ id: "new-prop" });
    pm.fieldSurveyPin.updateMany.mockResolvedValue({ count: 1 });
  });

  it("property:write が無ければ 403(pin を読まない)", async () => {
    (getUserPermissions as Mock).mockResolvedValue([]);
    const res = await POST(req({ propertyType: "land", address: "A" }), ctx);
    expect(res.status).toBe(403);
    expect(pm.fieldSurveyPin.findUnique).not.toHaveBeenCalled();
  });

  it("pin が無ければ 404", async () => {
    pm.fieldSurveyPin.findUnique.mockResolvedValue(null);
    const res = await POST(req({ propertyType: "land", address: "A" }), ctx);
    expect(res.status).toBe(404);
  });

  it("候補ピンでなければ 422(作成しない)", async () => {
    pm.fieldSurveyPin.findUnique.mockResolvedValue(candidatePin({ pinType: "blocked" }));
    const res = await POST(req({ propertyType: "land", address: "A" }), ctx);
    expect(res.status).toBe(422);
    expect(pm.property.create).not.toHaveBeenCalled();
  });

  it("アーカイブ済みピンは 409(作成しない)", async () => {
    pm.fieldSurveyPin.findUnique.mockResolvedValue(candidatePin({ status: "archived" }));
    const res = await POST(req({ propertyType: "land", address: "A" }), ctx);
    expect(res.status).toBe(409);
    expect(pm.property.create).not.toHaveBeenCalled();
  });

  it("既に propertyId があれば 409(作成しない)", async () => {
    pm.fieldSurveyPin.findUnique.mockResolvedValue(candidatePin({ propertyId: "p-x" }));
    const res = await POST(req({ propertyType: "land", address: "A" }), ctx);
    expect(res.status).toBe(409);
    expect(pm.property.create).not.toHaveBeenCalled();
  });

  it("成功: property 作成 + pin を propertyId=null 条件で closed 紐付け・GPS 継承・201", async () => {
    pm.fieldSurveyPin.findUnique.mockResolvedValue(candidatePin());
    const res = await POST(req({ propertyType: "land", address: "東京都..." }), ctx);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "new-prop" });
    expect(pm.property.create.mock.calls[0][0].data.gpsLat).toBe(35.5);
    expect(pm.property.create.mock.calls[0][0].data.introductionRoute).toBe("field_survey");
    const upd = pm.fieldSurveyPin.updateMany.mock.calls[0][0];
    expect(upd.where).toEqual({ id: PIN_ID, propertyId: null, pinType: "candidate", status: { not: "archived" } });
    expect(upd.data).toEqual({ propertyId: "new-prop", status: "closed" });
  });

  it("競合で pin が先に紐付いていたら 409(updateMany count=0 でロールバック)", async () => {
    pm.fieldSurveyPin.findUnique.mockResolvedValue(candidatePin());
    pm.fieldSurveyPin.updateMany.mockResolvedValue({ count: 0 });
    const res = await POST(req({ propertyType: "land", address: "A" }), ctx);
    expect(res.status).toBe(409);
  });

  it("他人の pin は read_all/manage が無ければ 403(作成しない)", async () => {
    pm.fieldSurveyPin.findUnique.mockResolvedValue(candidatePin({ staffUserId: "someone-else" }));
    const res = await POST(req({ propertyType: "land", address: "A" }), ctx);
    expect(res.status).toBe(403);
    expect(pm.property.create).not.toHaveBeenCalled();
  });

  it("他人の pin でも read_all があれば変換できる(office_staff・201)", async () => {
    (getUserPermissions as Mock).mockResolvedValue(WRITE_READ_ALL);
    pm.fieldSurveyPin.findUnique.mockResolvedValue(candidatePin({ staffUserId: "someone-else" }));
    const res = await POST(req({ propertyType: "land", address: "A" }), ctx);
    expect(res.status).toBe(201);
  });

  it("他人の pin でも manage があれば変換できる(201)", async () => {
    (getUserPermissions as Mock).mockResolvedValue(WRITE_MANAGE);
    pm.fieldSurveyPin.findUnique.mockResolvedValue(candidatePin({ staffUserId: "someone-else" }));
    const res = await POST(req({ propertyType: "land", address: "A" }), ctx);
    expect(res.status).toBe(201);
  });
});
