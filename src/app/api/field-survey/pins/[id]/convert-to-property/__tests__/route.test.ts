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
    parseJsonBody: vi.fn(async (req: any) => req.json()),
    handleApiError: vi.fn((e: any) =>
      Response.json(
        { error: { message: e?.message, code: e?.code } },
        { status: typeof e?.status === "number" ? e.status : 500 },
      ),
    ),
    apiResponse: vi.fn((data: unknown, status = 200) => Response.json(data, { status })),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: {
    fieldSurveyPin: { findUnique: vi.fn(), update: vi.fn() },
    property: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { POST } from "../route";

const pm = prisma as unknown as {
  fieldSurveyPin: { findUnique: Mock; update: Mock };
  property: { create: Mock };
  $transaction: Mock;
};
const WRITE = [{ resource: "property", action: "write", granted: true }];
const WRITE_MANAGE = [
  { resource: "property", action: "write", granted: true },
  { resource: "field_survey", action: "manage", granted: true },
];
const PIN_ID = "11111111-1111-1111-1111-111111111111";

function req(body: unknown) {
  return new Request(
    `http://localhost/api/field-survey/pins/${PIN_ID}/convert-to-property`,
    { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } },
  ) as unknown as import("next/server").NextRequest;
}
const ctx = { params: Promise.resolve({ id: PIN_ID }) };

describe("POST /api/field-survey/pins/[id]/convert-to-property", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getApiSession as Mock).mockResolvedValue({ id: "user-1", role: "member" });
    (getUserPermissions as Mock).mockResolvedValue(WRITE);
    pm.$transaction.mockImplementation(async (cb: any) =>
      cb({ property: { create: pm.property.create }, fieldSurveyPin: { update: pm.fieldSurveyPin.update } }),
    );
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

  it("既に propertyId があれば 409(作成しない)", async () => {
    pm.fieldSurveyPin.findUnique.mockResolvedValue({ id: PIN_ID, staffUserId: "user-1", propertyId: "p-x", lat: 35, lng: 139, status: "open" });
    const res = await POST(req({ propertyType: "land", address: "A" }), ctx);
    expect(res.status).toBe(409);
    expect(pm.property.create).not.toHaveBeenCalled();
  });

  it("成功: property 作成 + pin に propertyId/closed 紐付け・GPS はピン継承・201", async () => {
    pm.fieldSurveyPin.findUnique.mockResolvedValue({ id: PIN_ID, staffUserId: "user-1", propertyId: null, lat: 35.5, lng: 139.5, status: "open" });
    pm.property.create.mockResolvedValue({ id: "new-prop" });
    pm.fieldSurveyPin.update.mockResolvedValue({ id: PIN_ID });
    const res = await POST(req({ propertyType: "land", address: "東京都..." }), ctx);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "new-prop" });
    expect(pm.property.create.mock.calls[0][0].data.gpsLat).toBe(35.5);
    expect(pm.property.create.mock.calls[0][0].data.introductionRoute).toBe("field_survey");
    expect(pm.fieldSurveyPin.update.mock.calls[0][0].data).toEqual({ propertyId: "new-prop", status: "closed" });
  });

  it("他人の pin は manage が無ければ 403(作成しない)", async () => {
    pm.fieldSurveyPin.findUnique.mockResolvedValue({ id: PIN_ID, staffUserId: "someone-else", propertyId: null, lat: 35, lng: 139, status: "open" });
    const res = await POST(req({ propertyType: "land", address: "A" }), ctx);
    expect(res.status).toBe(403);
    expect(pm.property.create).not.toHaveBeenCalled();
  });

  it("他人の pin でも manage があれば変換できる(201)", async () => {
    (getUserPermissions as Mock).mockResolvedValue(WRITE_MANAGE);
    pm.fieldSurveyPin.findUnique.mockResolvedValue({ id: PIN_ID, staffUserId: "someone-else", propertyId: null, lat: 1, lng: 2, status: "open" });
    pm.property.create.mockResolvedValue({ id: "np" });
    pm.fieldSurveyPin.update.mockResolvedValue({ id: PIN_ID });
    const res = await POST(req({ propertyType: "land", address: "A" }), ctx);
    expect(res.status).toBe(201);
  });
});
