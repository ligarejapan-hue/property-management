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

const req = (order?: string) =>
  new Request(
    `http://localhost/api/field-survey/pins/candidates${order ? `?order=${order}` : ""}`,
  );

describe("GET /api/field-survey/pins/candidates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getApiSession as Mock).mockResolvedValue({ id: "user-1", role: "office_staff" });
    (getUserPermissions as Mock).mockResolvedValue(READ_ALL);
    pm.fieldSurveyPin.findMany.mockResolvedValue([]);
  });

  it("field_survey:read が無ければ 403", async () => {
    (getUserPermissions as Mock).mockResolvedValue([]);
    const res = await GET(req());
    expect(res.status).toBe(403);
  });

  it("候補 × open × 未紐付けのみ・read_all は全スタッフ分を対象", async () => {
    await GET(req());
    const where = pm.fieldSurveyPin.findMany.mock.calls[0][0].where;
    expect(where.pinType).toBe("candidate");
    expect(where.status).toBe("open");
    expect(where.propertyId).toBeNull();
    expect(where.staffUserId).toBeUndefined();
  });

  it("read_all/manage が無ければ own のみ(staffUserId 強制)", async () => {
    (getUserPermissions as Mock).mockResolvedValue(READ);
    await GET(req());
    const where = pm.fieldSurveyPin.findMany.mock.calls[0][0].where;
    expect(where.staffUserId).toBe("user-1");
  });

  it("order=oldest で古い順 (createdAt asc)", async () => {
    await GET(req("oldest"));
    const orderBy = pm.fieldSurveyPin.findMany.mock.calls[0][0].orderBy;
    expect(orderBy).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
  });

  it("order 未指定・不正値は新しい順 (createdAt desc) に倒す (allowlist)", async () => {
    await GET(req("bogus"));
    const orderBy = pm.fieldSurveyPin.findMany.mock.calls[0][0].orderBy;
    expect(orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });

  it("座標・memo 本文を返さず hasMemo + 写真サムネイルのみ(非PII)", async () => {
    pm.fieldSurveyPin.findMany.mockResolvedValue([
      {
        id: "p1",
        staffUserId: "u",
        createdAt: "2026-07-06T00:00:00Z",
        memo: "秘密メモ",
        photos: [
          { fileUrl: "/uploads/a.jpg", thumbnailUrl: "/uploads/a_thumb.jpg" },
        ],
        _count: { photos: 3 },
      },
      {
        id: "p2",
        staffUserId: "u",
        createdAt: "2026-07-06T00:00:00Z",
        memo: "  ",
        photos: [],
        _count: { photos: 0 },
      },
      {
        // 本番実態 (local backend): thumbnailUrl は生成されず null。
        // cover は原本 fileUrl に fallback する (normalizeFileUrl 適用)。
        id: "p3",
        staffUserId: "u",
        createdAt: "2026-07-06T00:00:00Z",
        memo: null,
        photos: [{ fileUrl: "/uploads/x.jpg", thumbnailUrl: null }],
        _count: { photos: 1 },
      },
    ]);
    const res = await GET(req());
    const body = await res.json();
    // 写真あり → cover (thumbnailUrl 優先) + 枚数
    expect(body.data[0]).toEqual({
      id: "p1",
      staffUserId: "u",
      createdAt: "2026-07-06T00:00:00Z",
      hasMemo: true,
      coverPhotoUrl: "/uploads/a_thumb.jpg",
      photoCount: 3,
    });
    // 写真なし → cover は null
    expect(body.data[1].hasMemo).toBe(false);
    expect(body.data[1].coverPhotoUrl).toBeNull();
    expect(body.data[1].photoCount).toBe(0);
    // 本番実態: thumbnailUrl null → 原本 fileUrl に fallback (P3 対応)
    expect(body.data[2].coverPhotoUrl).toBe("/uploads/x.jpg");
    expect(body.data[2].photoCount).toBe(1);
    expect(body.data[2].hasMemo).toBe(false);
    // PII 境界維持: 座標・memo 本文は返さない
    expect(body.data[0]).not.toHaveProperty("lat");
    expect(body.data[0]).not.toHaveProperty("lng");
    expect(body.data[0]).not.toHaveProperty("accuracy");
    expect(body.data[0]).not.toHaveProperty("memo");
    const select = pm.fieldSurveyPin.findMany.mock.calls[0][0].select;
    expect(select.lat).toBeUndefined();
    expect(select.lng).toBeUndefined();
    // cover は sortOrder 昇順の先頭 1 件だけ取得
    expect(select.photos.take).toBe(1);
    expect(select.photos.orderBy).toEqual([
      { sortOrder: "asc" },
      { createdAt: "asc" },
    ]);
  });
});
