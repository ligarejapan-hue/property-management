/**
 * POST /api/import/jobs/[jobId]/rows/bulk-resolve（B3）route テスト。
 *
 * 検証:
 *  - import:write を要求（403）
 *  - action=skip|mark_error / scope=needs_review|error の検証（422）
 *  - server-side where + updateMany（client から ID を受け取らない）
 *  - action=skip → data {status:"skipped","手動スキップ"} / mark_error → {status:"error","手動エラー確定"}
 *  - affectedCount を返す / recalculateJobCounts を呼ぶ / job 不在は 404
 *  - AuditLog は PII なし（action/status/count のみ）
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {
    constructor(input: string | URL | Request, init?: RequestInit) {
      super(input, init);
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
    apiResponse: vi.fn((data: unknown, status = 200) =>
      Response.json(data, { status }),
    ),
  };
});

vi.mock("@/lib/permissions", () => ({ hasPermission: vi.fn(() => true) }));

const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));

const { recalculateJobCounts } = vi.hoisted(() => ({
  recalculateJobCounts: vi.fn(),
}));
vi.mock("@/lib/import-job-counts", () => ({ recalculateJobCounts }));

vi.mock("@/lib/prisma", () => ({
  default: {
    importJob: { findUnique: vi.fn() },
    importJobRow: { updateMany: vi.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { POST } from "@/app/api/import/jobs/[jobId]/rows/bulk-resolve/route";

const pm = prisma as unknown as {
  importJob: { findUnique: Mock };
  importJobRow: { updateMany: Mock };
};

const JOB_ID = "job-1";

async function callPost(body: unknown, jobId = JOB_ID) {
  const req = new Request(
    `http://t/api/import/jobs/${jobId}/rows/bulk-resolve`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const res = await POST(req as never, { params: Promise.resolve({ jobId }) });
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Mock).mockResolvedValue([
    { resource: "import", action: "write", granted: true },
  ]);
  (hasPermission as Mock).mockReturnValue(true);
  pm.importJob.findUnique.mockResolvedValue({ id: JOB_ID });
  pm.importJobRow.updateMany.mockResolvedValue({ count: 0 });
  recalculateJobCounts.mockResolvedValue(undefined);
});

describe("POST bulk-resolve — B3", () => {
  it("scope=needs_review / action=skip: where と data が正しく affectedCount を返す", async () => {
    pm.importJobRow.updateMany.mockResolvedValue({ count: 7 });
    const { status, body } = await callPost({
      action: "skip",
      scope: "needs_review",
    });
    expect(status).toBe(200);
    expect(body.affectedCount).toBe(7);
    expect(pm.importJobRow.updateMany).toHaveBeenCalledTimes(1);
    const arg = pm.importJobRow.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ jobId: JOB_ID, status: "needs_review" });
    expect(arg.data).toEqual({ status: "skipped", errorMessage: "手動スキップ" });
    // client から ID を受け取らない（where は status フィルタのみ）
    expect(arg.where).not.toHaveProperty("id");
    expect(recalculateJobCounts).toHaveBeenCalledWith(JOB_ID);
  });

  it("scope=error / action=mark_error: where と data が正しい", async () => {
    pm.importJobRow.updateMany.mockResolvedValue({ count: 3 });
    const { status, body } = await callPost({
      action: "mark_error",
      scope: "error",
    });
    expect(status).toBe(200);
    expect(body.affectedCount).toBe(3);
    const arg = pm.importJobRow.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ jobId: JOB_ID, status: "error" });
    expect(arg.data).toEqual({ status: "error", errorMessage: "手動エラー確定" });
  });

  it("AuditLog は action/status/count のみ（PII なし）", async () => {
    pm.importJobRow.updateMany.mockResolvedValue({ count: 5 });
    await callPost({ action: "skip", scope: "needs_review" });
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    const audit = writeAuditLog.mock.calls[0][0];
    expect(audit.action).toBe("import_rows_bulk_resolve");
    expect(audit.targetTable).toBe("import_jobs");
    expect(audit.targetId).toBe(JOB_ID);
    expect(audit.detail).toEqual({
      action: "skip",
      status: "needs_review",
      count: 5,
    });
    const detailKeys = Object.keys(audit.detail);
    for (const k of ["name", "address", "phone", "rawData", "errorMessage"]) {
      expect(detailKeys).not.toContain(k);
    }
  });

  it("count 0 でも 200（冪等）", async () => {
    pm.importJobRow.updateMany.mockResolvedValue({ count: 0 });
    const { status, body } = await callPost({ action: "skip", scope: "error" });
    expect(status).toBe(200);
    expect(body.affectedCount).toBe(0);
  });

  it("import:write が無ければ 403（updateMany を呼ばない）", async () => {
    (hasPermission as Mock).mockReturnValue(false);
    const { status } = await callPost({ action: "skip", scope: "needs_review" });
    expect(status).toBe(403);
    expect(pm.importJobRow.updateMany).not.toHaveBeenCalled();
  });

  it("invalid action は 422", async () => {
    const { status } = await callPost({ action: "delete_all", scope: "error" });
    expect(status).toBe(422);
    expect(pm.importJobRow.updateMany).not.toHaveBeenCalled();
  });

  it("invalid scope（actionable 外）は 422", async () => {
    const { status } = await callPost({ action: "skip", scope: "success" });
    expect(status).toBe(422);
    expect(pm.importJobRow.updateMany).not.toHaveBeenCalled();
  });

  it("job 不在は 404", async () => {
    pm.importJob.findUnique.mockResolvedValue(null);
    const { status, body } = await callPost({
      action: "skip",
      scope: "needs_review",
    });
    expect(status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(pm.importJobRow.updateMany).not.toHaveBeenCalled();
  });
});

describe("POST bulk-resolve — B4 duplicate scope", () => {
  it("scope=duplicate / action=skip: where は status 非依存（needs_review + 「重複」始まり）", async () => {
    pm.importJobRow.updateMany.mockResolvedValue({ count: 4 });
    const { status, body } = await callPost({
      action: "skip",
      scope: "duplicate",
    });
    expect(status).toBe(200);
    expect(body.affectedCount).toBe(4);
    expect(pm.importJobRow.updateMany).toHaveBeenCalledTimes(1);
    const arg = pm.importJobRow.updateMany.mock.calls[0][0];
    // duplicate は status ではない: where は needs_review + errorMessage「重複」始まり。
    expect(arg.where).toEqual({
      jobId: JOB_ID,
      status: "needs_review",
      errorMessage: { startsWith: "重複" },
    });
    // status へ "duplicate" を直接渡していないこと（reception「住所」重複は対象外）。
    expect(arg.where.status).toBe("needs_review");
    // skip の data は B3 と同一（解決後は「重複」始まりでなくなり duplicateCount 単調減少）。
    expect(arg.data).toEqual({ status: "skipped", errorMessage: "手動スキップ" });
    expect(arg.where).not.toHaveProperty("id");
    expect(recalculateJobCounts).toHaveBeenCalledWith(JOB_ID);
  });

  it("scope=duplicate / action=mark_error: where は同一・data はエラー確定", async () => {
    pm.importJobRow.updateMany.mockResolvedValue({ count: 2 });
    const { status, body } = await callPost({
      action: "mark_error",
      scope: "duplicate",
    });
    expect(status).toBe(200);
    expect(body.affectedCount).toBe(2);
    const arg = pm.importJobRow.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({
      jobId: JOB_ID,
      status: "needs_review",
      errorMessage: { startsWith: "重複" },
    });
    expect(arg.data).toEqual({ status: "error", errorMessage: "手動エラー確定" });
  });

  it("AuditLog detail は { action, status:'duplicate', count } のみ（PII なし）", async () => {
    pm.importJobRow.updateMany.mockResolvedValue({ count: 6 });
    await callPost({ action: "skip", scope: "duplicate" });
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    const audit = writeAuditLog.mock.calls[0][0];
    expect(audit.action).toBe("import_rows_bulk_resolve");
    expect(audit.targetTable).toBe("import_jobs");
    expect(audit.targetId).toBe(JOB_ID);
    // detail.status には scope 値（"duplicate"）を格納（既存3キー形状維持）。
    expect(audit.detail).toEqual({
      action: "skip",
      status: "duplicate",
      count: 6,
    });
    const detailKeys = Object.keys(audit.detail);
    for (const k of ["name", "address", "phone", "rawData", "errorMessage"]) {
      expect(detailKeys).not.toContain(k);
    }
  });

  it("scope=duplicate でも count 0 は 200（冪等・再実行は 0 件）", async () => {
    pm.importJobRow.updateMany.mockResolvedValue({ count: 0 });
    const { status, body } = await callPost({
      action: "skip",
      scope: "duplicate",
    });
    expect(status).toBe(200);
    expect(body.affectedCount).toBe(0);
  });

  // ---- Plan-T(17-B): 既存仕様ロック（production 無変更） ----

  it("scope=duplicate / affectedCount=0 でも writeAuditLog を呼ぶ（count:0・PII なし・recalc も実行）", async () => {
    // 0 件でも監査は記録する＝「一括解決を試行した」証跡を残す現仕様をロックする。
    pm.importJobRow.updateMany.mockResolvedValue({ count: 0 });
    const { status, body } = await callPost({
      action: "skip",
      scope: "duplicate",
    });
    expect(status).toBe(200);
    expect(body.affectedCount).toBe(0);
    // updateMany は呼ばれ、その後 recalc / audit も件数に関わらず実行される。
    expect(pm.importJobRow.updateMany).toHaveBeenCalledTimes(1);
    expect(recalculateJobCounts).toHaveBeenCalledWith(JOB_ID);
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    const audit = writeAuditLog.mock.calls[0][0];
    expect(audit.action).toBe("import_rows_bulk_resolve");
    expect(audit.detail).toEqual({
      action: "skip",
      status: "duplicate",
      count: 0,
    });
    // PII / 識別子は detail に含めない（rawData / 住所 / 氏名 / duplicatePropertyId / errorMessage 本文）。
    const detailKeys = Object.keys(audit.detail);
    for (const k of [
      "name",
      "ownerName",
      "address",
      "phone",
      "rawData",
      "errorMessage",
      "duplicatePropertyId",
    ]) {
      expect(detailKeys).not.toContain(k);
    }
  });

  it("scope=duplicate の where は startsWith:'重複' を厳密維持＝reception「住所が既存物件と重複」を含めない（B4.1 現状維持ロック）", async () => {
    // B4.1 決定: reception の住所重複（prefix「住所」・rawData.duplicatePropertyId）は
    // duplicate scope に含めない。誰かが prefix-OR や rawData 条件へ拡張したら落ちる回帰ロック。
    pm.importJobRow.updateMany.mockResolvedValue({ count: 1 });
    await callPost({ action: "skip", scope: "duplicate" });
    const arg = pm.importJobRow.updateMany.mock.calls[0][0];

    // errorMessage prefix は「重複」厳密（「住所…」や OR 拡張をしていない）。
    expect(arg.where.errorMessage).toEqual({ startsWith: "重複" });
    expect(arg.where.errorMessage.startsWith).toBe("重複");
    expect(arg.where.errorMessage).not.toHaveProperty("OR");
    // where 全体に「住所」prefix も OR も rawData 条件も現れない。
    expect(JSON.stringify(arg.where)).not.toContain("住所");
    expect(arg.where).not.toHaveProperty("OR");
    expect(arg.where).not.toHaveProperty("rawData");
    // where の key は jobId / status / errorMessage の3つのみ（discriminator を増やしていない）。
    expect(Object.keys(arg.where).sort()).toEqual([
      "errorMessage",
      "jobId",
      "status",
    ]);
    // status は文字列 "needs_review"（"duplicate" を直接渡していない／detail の actionable と一致）。
    expect(arg.where.status).toBe("needs_review");
  });
});
