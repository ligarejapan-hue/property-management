/**
 * 取込エラー行を「既存の所有者に紐づける」ときの規則（設計 §6.3(2)(3)）。
 *
 * 守りたいこと:
 *  1. 行の確保 → 相手の補完 → 履歴 → 行の完了 を**1つの tx** で行う。
 *     2人が同じ行を別々の相手に解決すると、両方が相手を書き換えるのに行に残るのは
 *     最後の1つだけ。途中で失敗すると「相手だけ書き換わって行も履歴も無い」状態が残る。
 *  2. 補完はロックの下で読み直した値で決める。照合の時点で「空だった」ことを覚えたまま
 *     書くと、その間に人が手で入れた住所を取込の古い値で上書きする。
 *  3. 住所と郵便番号はペアで扱う（ズレた宛先を作らない）。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("next/server", () => ({ NextRequest: class {} }));

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
    getApiSession: vi.fn(async () => ({ id: "user-1", role: "admin" })),
    getUserPermissions: vi.fn(async () => [
      { resource: "import", action: "write", granted: true },
    ]),
    handleApiError: vi.fn((error: unknown) => {
      const e = error as { status?: number; message?: string; code?: string };
      return Response.json(
        { error: { message: e?.message ?? "", code: e?.code ?? "INTERNAL" } },
        { status: e?.status ?? 500 },
      );
    }),
    apiResponse: vi.fn((data: unknown, status = 200) =>
      Response.json(data, { status }),
    ),
  };
});

vi.mock("@/lib/permissions", () => ({ hasPermission: () => true }));
vi.mock("@/lib/import-job-guard", () => ({ assertImportJobMutable: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/owner-dedup", () => ({ findDuplicateOwner: vi.fn() }));
vi.mock("@/lib/import-job-counts", () => ({ recalculateJobCounts: vi.fn() }));
vi.mock("@/lib/storage", () => ({ getStorage: () => ({ delete: vi.fn() }) }));

vi.mock("@/lib/prisma", () => {
  const tx = {
    importJobRow: { updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
    owner: { updateMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    changeLog: { createMany: vi.fn() },
  };
  return {
    default: {
      importJobRow: { findUnique: vi.fn(), update: vi.fn() },
      owner: { findUnique: vi.fn() },
      property: { findUnique: vi.fn() },
      $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
      _tx: tx,
    },
  };
});

import prisma from "@/lib/prisma";
import { PATCH } from "../../app/api/import/jobs/[jobId]/rows/[rowId]/route";

const pm = prisma as unknown as {
  importJobRow: { findUnique: Mock; update: Mock };
  owner: { findUnique: Mock };
  $transaction: Mock;
  _tx: {
    importJobRow: { updateMany: Mock; findUniqueOrThrow: Mock };
    owner: { updateMany: Mock; findUnique: Mock; update: Mock };
    changeLog: { createMany: Mock };
  };
};

const JOB_ID = "job-1";
const ROW_ID = "row-1";
const OWNER_ID = "owner-1";

function makeRequest(body: unknown) {
  return {
    json: async () => body,
  } as unknown as Parameters<typeof PATCH>[0];
}

function makeParams() {
  return { params: Promise.resolve({ jobId: JOB_ID, rowId: ROW_ID }) };
}

function linkExisting() {
  return PATCH(
    makeRequest({ action: "link_existing", targetId: OWNER_ID }),
    makeParams(),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  pm.importJobRow.findUnique.mockResolvedValue({
    id: ROW_ID,
    jobId: JOB_ID,
    rowNumber: 3,
    status: "needs_review",
    rawData: {
      氏名: "山田太郎",
      現住所: "渋谷区神宮前1-1-1",
      現住所郵便番号: "150-0001",
    },
    job: { id: JOB_ID, jobType: "owner_csv", createdBy: "user-1" },
  });
  pm.owner.findUnique.mockResolvedValue({ id: OWNER_ID });
  pm._tx.importJobRow.updateMany.mockResolvedValue({ count: 1 });
  pm._tx.importJobRow.findUniqueOrThrow.mockResolvedValue({
    id: ROW_ID,
    status: "success",
  });
  pm._tx.owner.updateMany.mockResolvedValue({ count: 1 });
  pm._tx.owner.findUnique.mockResolvedValue({
    zip: null,
    address: null,
    currentZip: null,
    currentAddress: null,
  });
  pm._tx.owner.update.mockResolvedValue({});
  pm._tx.changeLog.createMany.mockResolvedValue({ count: 0 });
});

describe("PATCH .../rows/:rowId link_existing", () => {
  it("空欄の所有者に、取込の現住所をペアで入れる", async () => {
    const res = await linkExisting();
    expect(res.status).toBe(200);
    expect(pm._tx.owner.update).toHaveBeenCalledTimes(1);
    const data = pm._tx.owner.update.mock.calls[0][0].data;
    expect(data.currentAddress).toBe("渋谷区神宮前1-1-1");
    expect(data.currentZip).toBe("150-0001");
  });

  it("項目ごとの変更履歴を同じ処理の中で残す", async () => {
    await linkExisting();
    const rows = pm._tx.changeLog.createMany.mock.calls[0][0].data;
    const fields = rows.map((r: { fieldName: string }) => r.fieldName).sort();
    expect(fields).toEqual(["currentAddress", "currentZip"]);
    expect(rows[0].targetTable).toBe("owners");
    expect(rows[0].targetId).toBe(OWNER_ID);
  });

  it("⚠補完の直前に人が手で現住所を入れていたら、上書きしない", async () => {
    // ロックの下で読み直した値が「もう入っている」なら何も書かない。
    pm._tx.owner.findUnique.mockResolvedValue({
      zip: null,
      address: null,
      currentZip: "231-0842",
      currentAddress: "横浜市南区井土ケ谷中町69-2",
    });
    const res = await linkExisting();
    expect(res.status).toBe(200);
    expect(pm._tx.owner.update).not.toHaveBeenCalled();
    expect(pm._tx.changeLog.createMany).not.toHaveBeenCalled();
  });

  it("⚠同じ行を他の担当者が先に解決していたら 409（相手を書き換えない）", async () => {
    pm._tx.importJobRow.updateMany.mockResolvedValue({ count: 0 });
    const res = await linkExisting();
    expect(res.status).toBe(409);
    expect(pm._tx.owner.update).not.toHaveBeenCalled();
    expect(pm._tx.changeLog.createMany).not.toHaveBeenCalled();
  });

  it("行の確保と所有者の補完が同じ処理（tx）の中で行われる", async () => {
    await linkExisting();
    expect(pm.$transaction).toHaveBeenCalledTimes(1);
    // tx の外で行を更新していない（＝途中で失敗しても中途半端に残らない）。
    expect(pm.importJobRow.update).not.toHaveBeenCalled();
  });

  it("アーカイブ済みの所有者には書き込まない（行の解決だけ通す）", async () => {
    pm._tx.owner.updateMany.mockResolvedValue({ count: 0 });
    const res = await linkExisting();
    expect(res.status).toBe(200);
    expect(pm._tx.owner.update).not.toHaveBeenCalled();
  });
});
