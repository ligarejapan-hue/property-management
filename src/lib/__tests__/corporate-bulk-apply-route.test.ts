/**
 * POST /api/admin/owners/correction/corporate-number-bulk-apply の統合テスト。
 *
 * missing 限定で検出番号→国税庁lookup→found∧非廃止のとき corporateNumber のみ反映（A 案）。
 * version 楽観ロック・廃止/多重/未検出/設定済/競合は skip。lookup 未設定は 503。
 * permissions は実物。prisma / api-helpers / audit / change-log / 検出 / lookup は mock。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type { ApiSession, PermissionEntry } from "@/lib/api-helpers";

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
    apiResponse: vi.fn((data: unknown, status = 200) =>
      Response.json(data, { status }),
    ),
    handleApiError: vi.fn((error: unknown) => {
      if (error instanceof MockApiError) {
        return Response.json(
          { error: { message: error.message, code: error.code } },
          { status: error.status },
        );
      }
      return Response.json(
        { error: { message: "Server error", code: "INTERNAL_ERROR" } },
        { status: 500 },
      );
    }),
  };
});

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/change-log", () => ({
  recordChanges: vi.fn(),
  OWNER_TRACKED_FIELDS: ["corporateNumber"],
}));
vi.mock("@/lib/corporate-number", () => ({
  detectCorporateNumberInOwnerLike: vi.fn(),
}));
vi.mock("@/lib/corporate-lookup", () => ({
  isCorporateLookupConfigured: vi.fn(),
  lookupCorporateNumber: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  default: { owner: { findUnique: vi.fn(), updateMany: vi.fn() } },
}));

import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
} from "@/lib/api-helpers";
import { detectCorporateNumberInOwnerLike } from "@/lib/corporate-number";
import {
  isCorporateLookupConfigured,
  lookupCorporateNumber,
} from "@/lib/corporate-lookup";
import { recordChanges } from "@/lib/change-log";
import { POST } from "../../app/api/admin/owners/correction/corporate-number-bulk-apply/route";

const OWNER = "11111111-1111-4111-8111-111111111111";
const NUM = "1234567890123";

const p = prisma as unknown as {
  owner: { findUnique: Mock; updateMany: Mock };
};
const sessionMock = getApiSession as unknown as Mock;
const permsMock = getUserPermissions as unknown as Mock;
const displayConfigMock = getOwnerDisplayConfig as unknown as Mock;

/** raw-visible（full）の display config。name/address/note すべて検出対象。 */
const FULL_DISPLAY = {
  name: "full",
  address: "full",
  note: "full",
  corporateNumber: "full",
} as const;
const detectMock = detectCorporateNumberInOwnerLike as unknown as Mock;
const configuredMock = isCorporateLookupConfigured as unknown as Mock;
const lookupMock = lookupCorporateNumber as unknown as Mock;
const recordChangesMock = recordChanges as unknown as Mock;

const OWNER_WRITE: PermissionEntry[] = [
  { resource: "owner", action: "write", granted: true },
  { resource: "owner_corporate_number", action: "full", granted: true },
];

function req(owners: Array<{ ownerId: string; version: number }> = [
  { ownerId: OWNER, version: 1 },
]) {
  return new Request("http://t/", {
    method: "POST",
    body: JSON.stringify({ owners }),
    headers: { "content-type": "application/json" },
  }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionMock.mockResolvedValue({
    id: "admin1",
    email: "a@e.com",
    name: "A",
    role: "admin",
  } as ApiSession);
  permsMock.mockResolvedValue(OWNER_WRITE);
  displayConfigMock.mockResolvedValue(FULL_DISPLAY);
  configuredMock.mockReturnValue(true);
  // 既定: missing(null cn, version 1)・単一検出・found∧非廃止・update ok
  p.owner.findUnique.mockResolvedValue({
    id: OWNER,
    name: `法人番号 ${NUM}`,
    address: null,
    note: null,
    corporateNumber: null,
    version: 1,
    isArchived: false,
  });
  detectMock.mockReturnValue({ candidates: [NUM], detectedIn: ["name"] });
  lookupMock.mockResolvedValue({ found: true, isClosed: false, record: {} });
  p.owner.updateMany.mockResolvedValue({ count: 1 });
});

describe("corporate-number bulk apply", () => {
  it("owner:write 無 → 403", async () => {
    permsMock.mockResolvedValue([]);
    expect((await POST(req())).status).toBe(403);
  });
  it("owner_corporate_number field 権限 無 → 403（field-level bypass 防止）", async () => {
    permsMock.mockResolvedValue([
      { resource: "owner", action: "write", granted: true },
    ]);
    expect((await POST(req())).status).toBe(403);
  });
  it("lookup 未設定 → 503", async () => {
    configuredMock.mockReturnValue(false);
    expect((await POST(req())).status).toBe(503);
  });
  it("空 owners → 400 / 50 件超 → 400", async () => {
    expect((await POST(req([]))).status).toBe(400);
    const many = Array.from({ length: 51 }, () => ({
      ownerId: OWNER,
      version: 1,
    }));
    expect((await POST(req(many))).status).toBe(400);
  });

  it("applied: missing∧単一検出∧found∧非廃止 → corporateNumber のみ set", async () => {
    const body = await (await POST(req())).json();
    expect(body.results[0].status).toBe("applied");
    expect(body.applied).toBe(1);
    expect(p.owner.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        // Codex P2: corporateNumber: null を where に含め、missing のときだけ書き込む
        where: { id: OWNER, version: 1, corporateNumber: null },
        data: expect.objectContaining({ corporateNumber: NUM }),
      }),
    );
    expect(recordChangesMock).toHaveBeenCalled();
  });

  it("field-visibility: name がマスク（raw-visible でない）→ name 由来の番号は検出しない（P1 bypass 防止）", async () => {
    // owner_corporate_number は full（書込可）だが name は masked。
    displayConfigMock.mockResolvedValue({
      name: "masked",
      address: "full",
      note: "full",
      corporateNumber: "full",
    });
    // 番号は name にのみ混入。detect は実際に渡された raw 値に基づいて返す。
    p.owner.findUnique.mockResolvedValue({
      id: OWNER,
      name: `法人番号 ${NUM}`,
      address: null,
      note: null,
      corporateNumber: null,
      version: 1,
      isArchived: false,
    });
    detectMock.mockImplementation(
      (o: { name?: string | null; address?: string | null; note?: string | null }) => {
        const text = [o.name, o.address, o.note].filter(Boolean).join(" ");
        return text.includes(NUM)
          ? { candidates: [NUM], detectedIn: ["name"] }
          : { candidates: [], detectedIn: [] };
      },
    );
    const body = await (await POST(req())).json();
    // masked name は null 化されて detect に渡る → 検出なし → skip
    expect(detectMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: null }),
    );
    expect(body.results[0].status).toBe("no_single_detection");
    expect(lookupMock).not.toHaveBeenCalled();
    expect(p.owner.updateMany).not.toHaveBeenCalled();
  });

  it("already_set: 既存 corporateNumber 有 → skip（lookup/update しない）", async () => {
    p.owner.findUnique.mockResolvedValue({
      id: OWNER,
      name: "x",
      address: null,
      note: null,
      corporateNumber: "9999999999999",
      version: 1,
    });
    const body = await (await POST(req())).json();
    expect(body.results[0].status).toBe("already_set");
    expect(lookupMock).not.toHaveBeenCalled();
    expect(p.owner.updateMany).not.toHaveBeenCalled();
  });

  it("version_conflict: version 不一致 → skip", async () => {
    p.owner.findUnique.mockResolvedValue({
      id: OWNER,
      name: "x",
      address: null,
      note: null,
      corporateNumber: null,
      version: 5,
    });
    const body = await (await POST(req([{ ownerId: OWNER, version: 1 }]))).json();
    expect(body.results[0].status).toBe("version_conflict");
  });

  it("no_single_detection: 検出 0 / 2+ → skip", async () => {
    detectMock.mockReturnValue({ candidates: [], detectedIn: [] });
    expect((await (await POST(req())).json()).results[0].status).toBe(
      "no_single_detection",
    );
    detectMock.mockReturnValue({
      candidates: [NUM, "9999999999999"],
      detectedIn: ["name", "note"],
    });
    expect((await (await POST(req())).json()).results[0].status).toBe(
      "no_single_detection",
    );
  });

  it("lookup_no_result: found=false → skip", async () => {
    lookupMock.mockResolvedValue({ found: false, isClosed: false, record: null });
    const body = await (await POST(req())).json();
    expect(body.results[0].status).toBe("lookup_no_result");
    expect(p.owner.updateMany).not.toHaveBeenCalled();
  });

  it("closed: 廃止法人 → skip", async () => {
    lookupMock.mockResolvedValue({ found: true, isClosed: true, record: {} });
    const body = await (await POST(req())).json();
    expect(body.results[0].status).toBe("closed");
    expect(p.owner.updateMany).not.toHaveBeenCalled();
  });

  it("version_conflict(race): updateMany count 0 → conflict", async () => {
    p.owner.updateMany.mockResolvedValue({ count: 0 });
    const body = await (await POST(req())).json();
    expect(body.results[0].status).toBe("version_conflict");
    expect(recordChangesMock).not.toHaveBeenCalled();
  });

  it("archived owner → not_found（mutate しない）", async () => {
    p.owner.findUnique.mockResolvedValue({
      id: OWNER,
      name: "x",
      address: null,
      note: null,
      corporateNumber: null,
      version: 1,
      isArchived: true,
    });
    const body = await (await POST(req())).json();
    expect(body.results[0].status).toBe("not_found");
    expect(p.owner.updateMany).not.toHaveBeenCalled();
  });
});
