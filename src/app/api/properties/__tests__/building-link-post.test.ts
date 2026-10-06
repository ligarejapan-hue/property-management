/**
 * POST /api/properties — 作成と同じトランザクションで棟へつなぐ(設計 2026-10-04 §4.4)。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

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

const applyMock = vi.fn();
const auditLinkMock = vi.fn();
vi.mock("@/lib/building-link/apply", () => ({
  applyBuildingLink: (...a: unknown[]) => applyMock(...a),
  writeBuildingLinkAudit: (...a: unknown[]) => auditLinkMock(...a),
}));

const txMock = {
  property: {
    create: vi.fn(),
    findUniqueOrThrow: vi.fn(),
  },
};

vi.mock("@/lib/prisma", () => ({
  default: {
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(txMock)),
    property: { create: vi.fn() },
  },
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { POST } from "../route";

const PERMS_WRITE = [{ resource: "property", action: "write", granted: true }];

function req(body: unknown) {
  return new Request("http://localhost/api/properties", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({ id: "user-1", role: "admin" });
  (getUserPermissions as Mock).mockResolvedValue(PERMS_WRITE);
  txMock.property.create.mockResolvedValue({ id: "p1" });
  txMock.property.findUniqueOrThrow.mockResolvedValue({ id: "p1", buildingName: "正式名" });
  auditLinkMock.mockResolvedValue(undefined);
});

describe("POST /api/properties — 棟へのつなぎ", () => {
  it("作成と同じトランザクションで棟へつなぎ、応答に buildingLink を載せる", async () => {
    applyMock.mockResolvedValue({
      action: "created", building: { id: "b1", name: "正式名" }, previousBuildingId: null, renamedFrom: null, warnings: [],
    });
    const res = await POST(req({ propertyType: "apartment_unit", address: "東京都大田区南雪谷1丁目1", buildingName: " 正式名 " }));
    expect(res.status).toBe(201);
    expect(applyMock).toHaveBeenCalledWith(txMock, expect.objectContaining({
      propertyId: "p1", propertyType: "apartment_unit", buildingName: "正式名", choice: { kind: "auto" }, currentBuildingId: null,
    }));
    const json = await res.json();
    expect(json.buildingLink).toMatchObject({ action: "created" });
    expect(json.id).toBe("p1");
    expect(auditLinkMock).toHaveBeenCalledWith("user-1", "p1", expect.objectContaining({ action: "created" }));
  });

  it("buildingChoice=existing をそのまま渡す(uuid は小文字)", async () => {
    applyMock.mockResolvedValue({
      action: "linked", building: { id: "b1", name: "n" }, previousBuildingId: null, renamedFrom: null, warnings: [],
    });
    await POST(req({
      propertyType: "apartment_unit", address: "a市b町1", buildingName: "n",
      buildingChoice: { kind: "existing", buildingId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" },
    }));
    expect(applyMock.mock.calls[0][1].choice).toEqual({ kind: "existing", buildingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  });

  it("buildingChoice は物件の列として保存しない", async () => {
    applyMock.mockResolvedValue({
      action: "none", building: null, previousBuildingId: null, renamedFrom: null, warnings: [],
    });
    await POST(req({ propertyType: "land", address: "a市b町1", buildingChoice: { kind: "new" } }));
    expect(txMock.property.create.mock.calls[0][0].data).not.toHaveProperty("buildingChoice");
  });
});
