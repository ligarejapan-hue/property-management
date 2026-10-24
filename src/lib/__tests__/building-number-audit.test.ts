/**
 * 家屋番号チェック（read-only）の判定と GET /api/admin/building-number-audit。
 * データはすべて架空。
 */
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
    getApiSession: vi.fn().mockResolvedValue({ id: "user-1", role: "admin" }),
    getUserPermissions: vi.fn(),
    handleApiError: vi.fn((error: unknown) => {
      if (error instanceof MockApiError) {
        return Response.json({ error: { message: error.message, code: error.code } }, { status: error.status });
      }
      return Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 });
    }),
    apiResponse: vi.fn((data: unknown, status = 200) => Response.json(data, { status })),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: {
    property: { count: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    attachment: { findFirst: vi.fn() },
  },
}));
vi.mock("@/lib/storage", () => {
  const read = vi.fn();
  return { getStorage: () => ({ read, keyFromUrl: (u: string) => u }) };
});
vi.mock("@/lib/pdf-extract", () => ({ extractTextFromPdf: vi.fn() }));

import prisma from "@/lib/prisma";
import { getUserPermissions } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { getStorage } from "@/lib/storage";
import { extractTextFromPdf } from "@/lib/pdf-extract";
import { isRangeBuildingNumber, suggestBuildingNumberFromText } from "@/lib/building-number-audit";
import { GET as rawGET } from "@/app/api/admin/building-number-audit/route";
import { getApiSession } from "@/lib/api-helpers";

const GET = (after?: string) =>
  rawGET(new Request(`http://x/api/admin/building-number-audit${after ? `?after=${after}` : ""}`) as never);

const pm = prisma as unknown as {
  property: { count: Mock; findMany: Mock; update: Mock; updateMany: Mock };
  attachment: { findFirst: Mock };
};
const ADMIN = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "property", action: "read", granted: true },
];
const KUBUN_TEXT = [
  "┃専有部分の家屋番号│１－１－１ ～ １－１－４３ ┃",
  "┃ 表 題 部 （専有部分の建物の表示） │不動産番号│０１００００００００００１┃",
  "┃家屋番号 │架空一丁目 １番１の３８ │ ┃",
].join("\n");

describe("判定", () => {
  it("～/〜 を含む値を範囲とみなす", () => {
    expect(isRangeBuildingNumber("５－１－１ ～ ５－１－４３")).toBe(true);
    expect(isRangeBuildingNumber("5-1-1〜5-1-43")).toBe(true);
    expect(isRangeBuildingNumber("架空一丁目 １番１の３８")).toBe(false);
    expect(isRangeBuildingNumber(null)).toBe(false);
  });

  it("謄本の文字から部屋の家屋番号を候補にする（範囲しか無ければ候補なし）", () => {
    expect(suggestBuildingNumberFromText(KUBUN_TEXT)).toBe("架空一丁目 １番１の３８");
    expect(suggestBuildingNumberFromText("┃専有部分の家屋番号│１－１－１ ～ １－１－４３ ┃")).toBeNull();
  });
});

describe("GET /api/admin/building-number-audit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getUserPermissions as Mock).mockResolvedValue(ADMIN);
    pm.property.count.mockResolvedValue(2);
    pm.property.findMany.mockResolvedValue([
      { id: "p1", address: "東京都世田谷区架空一丁目1番地1", buildingName: "架空マンション", roomNo: "305", buildingNumber: "１－１－１ ～ １－１－４３" },
      { id: "p2", address: "東京都世田谷区架空二丁目2番地2", buildingName: null, roomNo: null, buildingNumber: "２－１ ～ ２－９" },
    ]);
    pm.attachment.findFirst.mockImplementation(async ({ where }: { where: { propertyId: string } }) =>
      where.propertyId === "p1" ? { fileUrl: "k1" } : null,
    );
    (getStorage().read as Mock).mockResolvedValue({ body: Buffer.from("pdf") });
    (extractTextFromPdf as Mock).mockResolvedValue(KUBUN_TEXT);
  });

  it("権限が無ければ 403 で、DB も監査も触らない", async () => {
    (getUserPermissions as Mock).mockResolvedValue([{ resource: "property", action: "read", granted: true }]);
    const res = await GET();
    expect(res.status).toBe(403);
    expect(pm.property.findMany).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("範囲が入った物件と、謄本から読み直した候補を返す", async () => {
    const body = await (await GET()).json();
    expect(body.total).toBe(2);
    expect(body.rows).toEqual([
      expect.objectContaining({ propertyId: "p1", suggestion: "架空一丁目 １番１の３８", status: "suggested" }),
      expect.objectContaining({ propertyId: "p2", suggestion: null, status: "no_registry" }),
    ]);
    // 削除済みを除いた最新の謄本を見る
    expect(pm.attachment.findFirst.mock.calls[0][0]).toMatchObject({
      where: { propertyId: "p1", type: "registry", isDeleted: false },
      orderBy: { createdAt: "desc" },
    });
  });

  it("書き換えない（read-only）", async () => {
    await GET();
    expect(pm.property.update).not.toHaveBeenCalled();
    expect(pm.property.updateMany).not.toHaveBeenCalled();
  });

  it("謄本を読めなければ「読めない」にする（例外を外へ出さない）", async () => {
    (extractTextFromPdf as Mock).mockRejectedValue(new Error("壊れたPDF 山田太郎"));
    const body = await (await GET()).json();
    expect(body.rows[0]).toMatchObject({ propertyId: "p1", status: "unreadable" });
  });

  it("監査記録は件数とフラグだけ（物件ID・住所・家屋番号を残さない）", async () => {
    await GET();
    const detail = (writeAuditLog as Mock).mock.calls[0][0].detail;
    expect(detail).toEqual({ total: 2, returned: 2, suggested: 1, truncated: false, timeBudgetExhausted: false });
    const s = JSON.stringify(detail);
    expect(s).not.toContain("p1");
    expect(s).not.toContain("世田谷");
    expect(s).not.toContain("１－１－１");
  });

  it("上限を超えるときは truncated と続きの起点（最後の物件ID）を返す", async () => {
    const many = Array.from({ length: 201 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      address: "東京都世田谷区架空",
      buildingName: null,
      roomNo: null,
      buildingNumber: "１－１ ～ １－９",
    }));
    pm.property.count.mockResolvedValue(201);
    pm.property.findMany.mockResolvedValue(many);
    pm.attachment.findFirst.mockResolvedValue(null);
    const body = await (await GET()).json();
    expect(body.truncated).toBe(true);
    expect(body.hasMore).toBe(true);
    expect(body.rows).toHaveLength(200);
    expect(body.nextCursor).toBe(many[199].id);
  });

  it("after を渡すと、その物件の次から点検する（同じ先頭を読み直さない）", async () => {
    const after = "00000000-0000-4000-8000-000000000123";
    await GET(after);
    expect(pm.property.findMany.mock.calls[0][0]).toMatchObject({ cursor: { id: after }, skip: 1 });
  });

  it("形の正しくない after は無視して先頭から", async () => {
    await GET("../etc");
    expect(pm.property.findMany.mock.calls[0][0].cursor).toBeUndefined();
  });

  it("謄本の読み直しが残り時間を超えたら待たずに未処理にし、続きの起点を返す", async () => {
    vi.useFakeTimers();
    try {
      (getStorage().read as Mock).mockImplementation(() => new Promise(() => {})); // 返ってこない読み取り
      const p = GET();
      await vi.advanceTimersByTimeAsync(41_000);
      const body = await (await p).json();
      expect(body.timeBudgetExhausted).toBe(true);
      expect(body.rows[0]).toMatchObject({ propertyId: "p1", status: "not_processed" });
      expect(body.hasMore).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("担当分しか見られない役割（field_staff）は、権限があっても使えない", async () => {
    (getApiSession as Mock).mockResolvedValueOnce({ id: "u2", role: "field_staff" });
    const res = await GET();
    expect(res.status).toBe(403);
    expect(pm.property.findMany).not.toHaveBeenCalled();
  });
});
