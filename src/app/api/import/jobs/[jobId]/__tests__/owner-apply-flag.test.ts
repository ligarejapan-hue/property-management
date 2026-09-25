/**
 * 取込の記録が「謄本から所有者をまとめて反映」のものかを、サーバ側で確定して返す。
 *
 * ⚠既存の「所有者事項PDF一括」に**相乗り**しているため、種別だけでは見分けられない。
 *   画面の表示名がこの印で切り替わるので、判定を画面側の行の覗き見に任せない
 *   (ページを送ると現在ページの行しか見えず誤判定する=受付帳×所有者で踏んだ穴)。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/api-helpers", () => ({
  ApiError: class extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  getApiSession: vi.fn(),
  getUserPermissions: vi.fn(),
  apiResponse: vi.fn((body: unknown, status = 200) =>
    Response.json(body as object, { status }),
  ),
  handleApiError: vi.fn((e: { status?: number; message?: string; code?: string }) =>
    Response.json(
      { error: { message: e?.message, code: e?.code } },
      { status: e?.status ?? 500 },
    ),
  ),
}));
vi.mock("@/lib/permissions", () => ({ hasPermission: () => true }));
vi.mock("@/lib/prisma", () => ({
  default: {
    importJob: { findUnique: vi.fn() },
    importJobRow: {
      findMany: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { buildRegistryOwnerApplyRawData } from "@/lib/registry-owner-bulk/marker";
import { GET } from "../route";

const pm = prisma as unknown as {
  importJob: { findUnique: Mock };
  importJobRow: { findMany: Mock; count: Mock; groupBy: Mock; findFirst: Mock };
};

const call = () =>
  GET(new Request("http://localhost/api/import/jobs/j1") as never, {
    params: Promise.resolve({ jobId: "j1" }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Mock).mockResolvedValue([]);
  pm.importJob.findUnique.mockResolvedValue({
    id: "j1",
    jobType: "registry_pdf_bulk",
    fileName: "謄本から所有者をまとめて反映",
    status: "processing",
    executedBy: "u1",
  });
  pm.importJobRow.findMany.mockResolvedValue([]);
  pm.importJobRow.count.mockResolvedValue(0);
  pm.importJobRow.groupBy.mockResolvedValue([]);
  pm.importJobRow.findFirst.mockResolvedValue(null);
});

describe("まとめて反映の記録の見分け", () => {
  it("印のある行があれば true", async () => {
    pm.importJobRow.findFirst.mockResolvedValue({
      rawData: buildRegistryOwnerApplyRawData({
        propertyId: "11111111-1111-4111-8111-111111111111",
        address: null,
      }),
    });
    const body = await (await call()).json();
    expect(body.isRegistryOwnerApplyJob).toBe(true);
  });

  it("⚠PDFを上げた一括取込の記録では false", async () => {
    pm.importJobRow.findFirst.mockResolvedValue({
      rawData: { fileName: "x.PDF", stagedKey: "staging/x.pdf" },
    });
    const body = await (await call()).json();
    expect(body.isRegistryOwnerApplyJob).toBe(false);
  });

  it("行が無い記録でも落ちない", async () => {
    const body = await (await call()).json();
    expect(body.isRegistryOwnerApplyJob).toBe(false);
  });

  it("⚠先頭の行を見る（ページ送りの影響を受けない）", async () => {
    await call();
    expect(pm.importJobRow.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { rowNumber: "asc" } }),
    );
  });
});
