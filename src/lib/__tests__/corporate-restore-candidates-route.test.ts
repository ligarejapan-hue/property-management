/**
 * GET /api/admin/owners/correction/corporate-restore-candidates の統合テスト。
 *
 * 割れた会社法人等番号(住所末尾断片+数字氏名 / 氏名内断片)を検出して dry-run 一覧を返す。
 * 検出エンジン(corporate-number-restore)は純関数なので実物を使い、
 * prisma / api-helpers / audit は mock。マスキングは display-level 実物。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type { PermissionEntry } from "@/lib/api-helpers";

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
vi.mock("@/lib/prisma", () => ({
  default: { owner: { findMany: vi.fn() } },
}));

import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { GET } from "../../app/api/admin/owners/correction/corporate-restore-candidates/route";

const p = prisma as unknown as { owner: { findMany: Mock } };
const sessionMock = getApiSession as unknown as Mock;
const permsMock = getUserPermissions as unknown as Mock;
const displayConfigMock = getOwnerDisplayConfig as unknown as Mock;
const auditMock = writeAuditLog as unknown as Mock;

const ADMIN_PERMS: PermissionEntry[] = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
];

const FULL_DISPLAY = {
  name: "full",
  address: "full",
  note: "full",
  corporateNumber: "full",
} as const;

const SPLIT_OWNER = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "５９４４２",
  address:
    "東京都渋谷区渋谷二丁目１７番１号渋谷アクシュ２１Ｆ会社法人等番号０１１０－０１－０",
  version: 2,
};
const FRAGMENT_OWNER = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "株式会社テスト商事会社法人等番号０１２４－０１－０",
  address: "東京都中央区銀座1-1-1",
  version: 1,
};
const FRAGMENT_NO_NAME_OWNER = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "会社法人等番号２９００－０１－０",
  address: "北海道札幌市1-1",
  version: 1,
};
const NORMAL_OWNER = {
  id: "44444444-4444-4444-8444-444444444444",
  name: "田中一郎",
  address: "東京都千代田区1-1",
  version: 1,
};
// 取込ガード適用後: 番号は復元済みだが会社名が数字のまま(第3型)
const NAME_LOST_OWNER = {
  id: "55555555-5555-4555-8555-555555555555",
  name: "５９４４２",
  address: "東京都渋谷区渋谷二丁目１７番１号",
  corporateNumber: "4011001059442",
  version: 4,
};

function req() {
  return new Request("http://t/api/x") as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionMock.mockResolvedValue({ id: "user-1" });
  permsMock.mockResolvedValue(ADMIN_PERMS);
  displayConfigMock.mockResolvedValue(FULL_DISPLAY);
  p.owner.findMany.mockResolvedValue([
    SPLIT_OWNER,
    FRAGMENT_OWNER,
    FRAGMENT_NO_NAME_OWNER,
    NORMAL_OWNER,
    NAME_LOST_OWNER,
  ]);
});

describe("認可", () => {
  it("user_management:read が無ければ 403", async () => {
    permsMock.mockResolvedValue([
      { resource: "owner", action: "read", granted: true },
    ]);
    const res = await GET(req());
    expect(res.status).toBe(403);
  });

  it("owner:read が無ければ 403", async () => {
    permsMock.mockResolvedValue([
      { resource: "user_management", action: "read", granted: true },
    ]);
    const res = await GET(req());
    expect(res.status).toBe(403);
  });

  it("owner_corporate_number=hidden は 403(一覧を見せない)", async () => {
    displayConfigMock.mockResolvedValue({
      ...FULL_DISPLAY,
      corporateNumber: "hidden",
    });
    const res = await GET(req());
    expect(res.status).toBe(403);
  });
});

describe("検出と応答", () => {
  it("分断型・断片型・番号あり氏名欠落型を検出し、通常の所有者は含めない", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toHaveLength(4);
    const types = body.rows.map((r: { type: string }) => r.type);
    expect(types).toContain("address_name_split");
    expect(types).toContain("number_set_name_lost");
    expect(types.filter((t: string) => t === "name_fragment")).toHaveLength(2);
    expect(
      body.rows.find(
        (r: { ownerId: string }) => r.ownerId === NORMAL_OWNER.id,
      ),
    ).toBeUndefined();
  });

  it("分断型は復元12桁/13桁を返し eligible=true", async () => {
    const res = await GET(req());
    const body = await res.json();
    const row = body.rows.find(
      (r: { ownerId: string }) => r.ownerId === SPLIT_OWNER.id,
    );
    expect(row.registry12Masked).toBe("011001059442"); // full権限=生値
    expect(row.corporate13Masked).toMatch(/^\d{13}$/);
    expect(row.corporate13Masked.slice(1)).toBe("011001059442");
    expect(row.eligible).toBe(true);
    expect(row.version).toBe(2);
    expect(row.detailUrl).toBe(`/admin/owners/${SPLIT_OWNER.id}`);
  });

  it("断片型は会社名救出のみ(eligible=会社名の有無)", async () => {
    const res = await GET(req());
    const body = await res.json();
    const withName = body.rows.find(
      (r: { ownerId: string }) => r.ownerId === FRAGMENT_OWNER.id,
    );
    expect(withName.cleanedNameMasked).toBe("株式会社テスト商事");
    expect(withName.registry12Masked).toBeNull();
    expect(withName.eligible).toBe(true);
    const noName = body.rows.find(
      (r: { ownerId: string }) => r.ownerId === FRAGMENT_NO_NAME_OWNER.id,
    );
    expect(noName.eligible).toBe(false);
  });

  it("summary に種別件数を返す", async () => {
    const res = await GET(req());
    const body = await res.json();
    expect(body.summary).toEqual({
      split: 1,
      fragment: 2,
      nameLost: 1,
      total: 4,
    });
  });

  it("番号あり氏名欠落型は既存13桁を返し eligible=true", async () => {
    const res = await GET(req());
    const body = await res.json();
    const row = body.rows.find(
      (r: { ownerId: string }) => r.ownerId === NAME_LOST_OWNER.id,
    );
    expect(row.type).toBe("number_set_name_lost");
    expect(row.corporate13Masked).toBe("4011001059442"); // full権限=生値
    expect(row.registry12Masked).toBe("011001059442");
    expect(row.eligible).toBe(true);
  });

  it("corporateNumber=masked のとき復元番号はマスクされる(先頭4桁+***)", async () => {
    displayConfigMock.mockResolvedValue({
      ...FULL_DISPLAY,
      corporateNumber: "masked",
    });
    const res = await GET(req());
    const body = await res.json();
    const row = body.rows.find(
      (r: { ownerId: string }) => r.ownerId === SPLIT_OWNER.id,
    );
    expect(row.registry12Masked).toBe("0110*********");
    expect(row.corporate13Masked).toMatch(/^\d{4}\*{9}$/);
  });

  it("name が raw-visible でないユーザーには検出させない(fail-safe)", async () => {
    displayConfigMock.mockResolvedValue({
      ...FULL_DISPLAY,
      name: "masked",
    });
    const res = await GET(req());
    const body = await res.json();
    // 分断型(氏名依存)・断片型(氏名依存)とも検出されない
    expect(body.rows).toHaveLength(0);
  });

  it("audit に件数のみ記録する(生値・owner id 配列なし)", async () => {
    await GET(req());
    expect(auditMock).toHaveBeenCalledTimes(1);
    const arg = auditMock.mock.calls[0][0];
    const detailStr = JSON.stringify(arg.detail ?? {});
    expect(detailStr).not.toContain("011001059442");
    expect(detailStr).not.toContain(SPLIT_OWNER.id);
    expect(detailStr).not.toContain("渋谷");
  });
});
