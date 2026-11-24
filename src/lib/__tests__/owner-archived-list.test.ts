/**
 * アーカイブ済みの所有者の一覧(2026-11-24 発注者「作る」)。
 *  - classifyArchiveOrigin: 統合で隠れたのか、アーカイブで隠したのかを履歴の日時で決める
 *  - GET /api/admin/owners/correction/archived: アーカイブ済みだけを、表示権限どおりに伏せて返す
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { classifyArchiveOrigin } from "../owner-archived";

describe("classifyArchiveOrigin", () => {
  const t = (s: string) => new Date(s);
  it("統合の記録が無ければ アーカイブ", () => {
    expect(classifyArchiveOrigin({ lastArchivedAt: t("2026-11-01"), lastMergedAt: null })).toBe("archived");
    expect(classifyArchiveOrigin({ lastArchivedAt: null, lastMergedAt: null })).toBe("archived");
  });
  it("統合の記録だけなら 統合", () => {
    expect(classifyArchiveOrigin({ lastArchivedAt: null, lastMergedAt: t("2026-11-01") })).toBe("merged");
  });
  it("同じ時刻(統合は同じ取引で isArchived も書く)なら 統合", () => {
    expect(
      classifyArchiveOrigin({ lastArchivedAt: t("2026-11-01T10:00:00Z"), lastMergedAt: t("2026-11-01T10:00:00Z") }),
    ).toBe("merged");
  });
  it("統合のあとに改めてアーカイブされていれば アーカイブ", () => {
    expect(
      classifyArchiveOrigin({ lastArchivedAt: t("2026-11-05"), lastMergedAt: t("2026-11-01") }),
    ).toBe("archived");
  });
});

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
    getApiSession: vi.fn().mockResolvedValue({ id: "user-1" }),
    getUserPermissions: vi.fn(),
    getOwnerDisplayConfig: vi.fn(),
    handleApiError: vi.fn((error: unknown) => {
      if (error instanceof MockApiError) {
        return Response.json({ error: { message: error.message, code: error.code } }, { status: error.status });
      }
      return Response.json({ error: { message: String(error) } }, { status: 500 });
    }),
    apiResponse: vi.fn((data: unknown, status = 200) => Response.json(data, { status })),
  };
});

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  default: {
    owner: { findMany: vi.fn(), count: vi.fn() },
    changeLog: { findMany: vi.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { GET } from "../../app/api/admin/owners/correction/archived/route";

const pm = prisma as unknown as {
  owner: { findMany: Mock; count: Mock };
  changeLog: { findMany: Mock };
};

const PERMS = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
];

const A = "aaaaaaaa-0000-4000-8000-000000000001"; // 統合で隠れた
const B = "aaaaaaaa-0000-4000-8000-000000000002"; // アーカイブした
const M = "bbbbbbbb-0000-4000-8000-000000000009"; // 統合先

const get = (qs = "") =>
  GET(new Request(`http://localhost/api/admin/owners/correction/archived${qs}`) as unknown as import("next/server").NextRequest);

beforeEach(() => {
  vi.clearAllMocks();
  (getUserPermissions as Mock).mockResolvedValue(PERMS);
  (getOwnerDisplayConfig as Mock).mockResolvedValue({ name: "full", address: "masked" });
  pm.owner.count.mockResolvedValue(2);
  pm.owner.findMany.mockImplementation(async (args: { where: { isArchived?: boolean; id?: unknown } }) => {
    if (args.where.isArchived === true) {
      return [
        { id: A, name: "山田太郎", address: "東京都港区1-2-3", version: 2 },
        { id: B, name: "佐藤花子", address: "大阪府大阪市4-5-6", version: 1 },
      ];
    }
    // 統合先の名前の引き当て
    return [{ id: M, name: "山田太郎", isArchived: false }];
  });
  pm.changeLog.findMany.mockImplementation(async (args: { where: { fieldName: string } }) => {
    if (args.where.fieldName === "_merged_from") {
      return [{ targetId: M, newValue: A, changedAt: new Date("2026-11-01T10:00:00Z") }];
    }
    return [
      { targetId: A, changedAt: new Date("2026-11-01T10:00:00Z") },
      { targetId: B, changedAt: new Date("2026-10-20T10:00:00Z") },
    ];
  });
});

describe("GET archived", () => {
  it("アーカイブ済みだけを、統合かどうか・統合先・隠した日と一緒に返す", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(pm.owner.findMany.mock.calls[0][0].where).toEqual({ isArchived: true });
    expect(body.total).toBe(2);
    expect(body.rows).toHaveLength(2);
    const a = body.rows.find((r: { ownerId: string }) => r.ownerId === A);
    expect(a).toMatchObject({
      ownerNameMasked: "山田太郎",
      origin: "merged",
      mergedInto: { ownerId: M, ownerNameMasked: "山田太郎", isArchived: false },
      archivedAt: "2026-11-01T10:00:00.000Z",
      version: 2,
    });
    const b = body.rows.find((r: { ownerId: string }) => r.ownerId === B);
    expect(b).toMatchObject({ origin: "archived", mergedInto: null });
  });

  it("住所・氏名は表示権限どおりに伏せる", async () => {
    (getOwnerDisplayConfig as Mock).mockResolvedValue({ name: "hidden", address: "masked" });
    const body = await (await get()).json();
    const a = body.rows.find((r: { ownerId: string }) => r.ownerId === A);
    expect(a.ownerNameMasked).toBeNull();
    expect(a.addressMasked).toBe("***-2-3");
    expect(a.mergedInto.ownerNameMasked).toBeNull();
    expect(JSON.stringify(body)).not.toContain("山田太郎");
  });

  it("権限が無ければ 403", async () => {
    (getUserPermissions as Mock).mockResolvedValue(PERMS.slice(1));
    expect((await get()).status).toBe(403);
    (getUserPermissions as Mock).mockResolvedValue(PERMS.slice(0, 1));
    expect((await get()).status).toBe(403);
  });

  it("頁は page で送る(50件ずつ)", async () => {
    await get("?page=2");
    const args = pm.owner.findMany.mock.calls[0][0];
    expect(args.skip).toBe(100);
    expect(args.take).toBe(50);
  });

  it("監査には件数だけを書く(id・氏名を入れない)", async () => {
    await get();
    const detail = (writeAuditLog as Mock).mock.calls[0][0];
    expect(detail.action).toBe("owner_correction_archived_list");
    expect(JSON.stringify(detail)).not.toContain(A);
    expect(JSON.stringify(detail)).not.toContain("山田");
  });
});
