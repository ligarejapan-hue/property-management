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
  handleApiError: vi.fn(
    (e: { status?: number; message?: string; code?: string }) =>
      Response.json(
        { error: { message: e?.message, code: e?.code } },
        { status: e?.status ?? 500 },
      ),
  ),
}));
vi.mock("@/lib/permissions", () => ({ hasPermission: () => true }));
vi.mock("@/lib/prisma", () => ({
  default: {
    $transaction: vi.fn(),
    importJob: { count: vi.fn(), findMany: vi.fn() },
    importJobRow: { groupBy: vi.fn() },
    auditLog: { findMany: vi.fn() },
  },
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { GET } from "../route";

type PM = {
  $transaction: Mock;
  importJob: { count: Mock; findMany: Mock };
  importJobRow: { groupBy: Mock };
  auditLog: { findMany: Mock };
};
const pm = prisma as unknown as PM;

function call(query = "") {
  const req = new Request(`http://localhost/api/import/jobs${query}`);
  return GET(req as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Mock).mockResolvedValue([]);
  // $transaction は配列形式(すでに作られた promise の束)をそのまま解決する
  pm.$transaction.mockImplementation(async (ops: Promise<unknown>[]) =>
    Promise.all(ops),
  );
  pm.importJob.count.mockResolvedValue(0);
  pm.importJob.findMany.mockResolvedValue([]);
  pm.importJobRow.groupBy.mockResolvedValue([]);
  pm.auditLog.findMany.mockResolvedValue([]);
});

describe("GET /api/import/jobs jobTypeフィルタ", () => {
  it("registry_pdf_bulk が許可リストに含まれ where に反映される(@codex PR#256 P2)", async () => {
    const res = await call("?jobType=registry_pdf_bulk");
    expect(res.status).toBe(200);
    expect(pm.importJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ jobType: "registry_pdf_bulk" }),
      }),
    );
  });

  it("既存種別(property_csv)も従来どおり反映される", async () => {
    await call("?jobType=property_csv");
    expect(pm.importJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ jobType: "property_csv" }),
      }),
    );
  });

  /**
   * ⚠なぜ必要か(@codex 第8R P2): まとめて反映は1件ごとに共通処理を通すので、その内部で
   *   1件分の取込記録ができる。100件で101本、5,000件で5,001本が履歴に並び、見るべき
   *   まとめて反映のジョブが埋もれる。1件分の記録は履歴の一覧から外す。
   */
  it("⚠まとめて反映の1件分の記録は、取込の履歴に並べない", async () => {
    await call("");
    const arg = pm.importJob.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(arg.where.NOT).toEqual({
      jobType: "property_pdf",
      fileName: "謄本から所有者をまとめて反映（1件分）",
    });
    const countArg = pm.importJob.count.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(countArg.where.NOT).toEqual(arg.where.NOT);
  });

  it("不正な種別は黙って無視される(whereにjobTypeが入らない)", async () => {
    await call("?jobType=bogus_type");
    const arg = pm.importJob.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(arg.where).not.toHaveProperty("jobType");
  });
});
