/**
 * 一括ジョブの DB ロジック(createBulkFetchJob / getBulkJobProgress)。
 *
 * ⚠createBulkFetchJob: 可視物件だけ項目化・番号あり/所在不足は即 skipped・50件上限。
 * ⚠getBulkJobProgress: **可視項目でフィルタ + 件数を再計算**(担当替え/削除された物件の
 *   処理結果を数字からも漏らさない)・作成者本人のみ。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({
  default: {
    property: { findMany: vi.fn() },
    registryFetchJob: { create: vi.fn(), findUnique: vi.fn() },
    registryFetchJobItem: { createMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));
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
  return { ApiError: MockApiError };
});

import prisma from "@/lib/prisma";
import { ApiError } from "@/lib/api-helpers";
import { createBulkFetchJob, getBulkJobProgress } from "../jobs";

const pm = prisma as unknown as {
  property: { findMany: Mock };
  registryFetchJob: { create: Mock; findUnique: Mock };
  registryFetchJobItem: { createMany: Mock };
  $transaction: Mock;
};

const STAFF = { id: "u1", role: "field_staff" };
// 物件IDは UUID 検証を通す必要がある(createBulkFetchJob が不正UUIDを 400 で弾く)。
const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const P3 = "33333333-3333-4333-8333-333333333333";
const P4 = "44444444-4444-4444-8444-444444444444";
const P9 = "99999999-9999-4999-8999-999999999999";
const JOB_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

beforeEach(() => {
  vi.clearAllMocks();
  pm.$transaction.mockImplementation((cb: (tx: typeof prisma) => unknown) => cb(prisma));
  pm.registryFetchJob.create.mockResolvedValue({ id: "job-1" });
  pm.registryFetchJobItem.createMany.mockResolvedValue({ count: 0 });
});

describe("createBulkFetchJob", () => {
  it("空の選択 → 400", async () => {
    await expect(
      createBulkFetchJob({ session: STAFF, propertyIds: [], certificateType: "owner" }),
    ).rejects.toMatchObject({ status: 400, code: "REGISTRY_BULK_NO_TARGETS" });
  });

  it("50件超 → 400(分割案内)", async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `p${i}`);
    await expect(
      createBulkFetchJob({ session: STAFF, propertyIds: ids, certificateType: "owner" }),
    ).rejects.toMatchObject({ status: 400, code: "REGISTRY_BULK_TOO_MANY" });
  });

  it("不正な物件ID(UUIDでない) → 400(DB照会前に弾く)", async () => {
    await expect(
      createBulkFetchJob({ session: STAFF, propertyIds: ["not-a-uuid"], certificateType: "owner" }),
    ).rejects.toMatchObject({ status: 400, code: "REGISTRY_BULK_INVALID_PROPERTY_ID" });
    expect(pm.property.findMany).not.toHaveBeenCalled();
  });

  it("可視物件だけ項目化し、番号あり/所在不足は即 skipped、見えない物件は excluded", async () => {
    pm.property.findMany.mockResolvedValue([
      { id: P1, createdBy: "u1", assignedTo: null, address: "東京都A区1", lotNumber: "1", buildingNumber: null, realEstateNumber: null }, // 検索可 → pending
      { id: P2, createdBy: "u1", assignedTo: null, address: "東京都B区2", lotNumber: null, buildingNumber: null, realEstateNumber: "9999" }, // 番号あり → skipped
      { id: P3, createdBy: "u1", assignedTo: null, address: null, lotNumber: null, buildingNumber: null, realEstateNumber: null }, // 所在不足 → skipped
      { id: P4, createdBy: "other", assignedTo: "other", address: "東京都C区3", lotNumber: "3", buildingNumber: null, realEstateNumber: null }, // 見えない → excluded
    ]);

    const res = await createBulkFetchJob({
      session: STAFF,
      propertyIds: [P1, P2, P3, P4],
      certificateType: "owner",
    });

    expect(res).toMatchObject({ jobId: "job-1", total: 3, pending: 1, skipped: 2, excluded: 1 });
    // createMany に渡った項目の status を検証。
    const items = pm.registryFetchJobItem.createMany.mock.calls[0][0].data as Array<{
      propertyId: string;
      status: string;
      errorCode: string | null;
    }>;
    const byId = Object.fromEntries(items.map((i) => [i.propertyId, i]));
    expect(byId[P1].status).toBe("pending");
    expect(byId[P2]).toMatchObject({ status: "skipped", errorCode: "has_real_estate_number" });
    expect(byId[P3]).toMatchObject({ status: "skipped", errorCode: "insufficient_location" });
    expect(byId[P4]).toBeUndefined(); // 見えない物件は項目にしない
  });

  it("可視物件がゼロ → 403", async () => {
    pm.property.findMany.mockResolvedValue([
      { id: P9, createdBy: "other", assignedTo: "other", address: "x", lotNumber: null, buildingNumber: null, realEstateNumber: null },
    ]);
    await expect(
      createBulkFetchJob({ session: STAFF, propertyIds: [P9], certificateType: "owner" }),
    ).rejects.toMatchObject({ status: 403, code: "REGISTRY_BULK_NO_VISIBLE" });
  });

  it("同じ idempotencyKey の既存ジョブがあれば作らず返す(二重作成防止)", async () => {
    // 既存ジョブが見つかる → create を呼ばずそれを返す。
    pm.registryFetchJob.findUnique.mockResolvedValue({
      id: "job-existing",
      items: [{ status: "pending" }, { status: "pending" }, { status: "skipped" }],
    });

    const res = await createBulkFetchJob({
      session: STAFF,
      propertyIds: [P1],
      certificateType: "owner",
      idempotencyKey: "key-123",
    });

    expect(res.jobId).toBe("job-existing");
    expect(res).toMatchObject({ total: 3, pending: 2, skipped: 1 });
    expect(pm.registryFetchJob.create).not.toHaveBeenCalled();
    expect(pm.property.findMany).not.toHaveBeenCalled(); // 冪等ヒットは物件検索もしない
  });

  it("同じキーで内容の異なる要求(指紋不一致)は 409 で弾く(古いジョブを返さない)", async () => {
    // 既存ジョブは別の指紋(違う物件/種別で作られた)。
    pm.registryFetchJob.findUnique.mockResolvedValue({
      id: "job-old",
      requestFingerprint: "DIFFERENT_FINGERPRINT_0000000000",
      items: [{ status: "pending" }],
    });
    await expect(
      createBulkFetchJob({
        session: STAFF,
        propertyIds: [P1],
        certificateType: "owner",
        idempotencyKey: "key-123",
      }),
    ).rejects.toMatchObject({ status: 409, code: "REGISTRY_BULK_IDEMPOTENCY_MISMATCH" });
    expect(pm.registryFetchJob.create).not.toHaveBeenCalled();
  });

  it("idempotencyKey を job 作成データに渡す", async () => {
    pm.registryFetchJob.findUnique.mockResolvedValue(null); // 既存なし
    pm.property.findMany.mockResolvedValue([
      { id: P1, createdBy: "u1", assignedTo: null, address: "東京都A区1", lotNumber: "1", buildingNumber: null, realEstateNumber: null },
    ]);

    await createBulkFetchJob({
      session: STAFF,
      propertyIds: [P1],
      certificateType: "owner",
      idempotencyKey: "key-xyz",
    });

    expect(pm.registryFetchJob.create.mock.calls[0][0].data).toMatchObject({
      idempotencyKey: "key-xyz",
      requestedById: "u1",
    });
  });
});

describe("getBulkJobProgress — 可視項目でフィルタ + 件数再計算", () => {
  it("不正な jobId(UUIDでない) → 400(DB照会前に弾く)", async () => {
    await expect(
      getBulkJobProgress({ session: STAFF, jobId: "not-a-uuid" }),
    ).rejects.toMatchObject({ status: 400, code: "REGISTRY_BULK_INVALID_JOB_ID" });
    expect(pm.registryFetchJob.findUnique).not.toHaveBeenCalled();
  });

  it("作成者以外は 403", async () => {
    pm.registryFetchJob.findUnique.mockResolvedValue({
      id: "job-1", requestedById: "u1", status: "processing", certificateType: "owner",
      pausedReason: null, activeItemId: null, items: [],
    });
    await expect(
      getBulkJobProgress({ session: { id: "u2", role: "field_staff" }, jobId: JOB_ID }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("担当替え/削除された物件の項目は伏せ、件数は可視項目から数え直す", async () => {
    pm.registryFetchJob.findUnique.mockResolvedValue({
      id: "job-1",
      requestedById: "u1",
      status: "processing",
      certificateType: "owner",
      pausedReason: null,
      activeItemId: null,
      items: [
        // 見える(自分の物件)・done
        { id: "i1", propertyId: "p1", status: "done", errorCode: null, property: { createdBy: "u1", assignedTo: null } },
        // 担当替えで見えなくなった → 伏せる(処理結果 done を漏らさない)
        { id: "i2", propertyId: "p2", status: "done", errorCode: null, property: { createdBy: "other", assignedTo: "other" } },
        // 物件削除(property=null) → 伏せる
        { id: "i3", propertyId: null, status: "failed", errorCode: "timeout", property: null },
      ],
    });

    const p = await getBulkJobProgress({ session: STAFF, jobId: JOB_ID });

    // 可視は i1 のみ。
    expect(p.items.map((i) => i.id)).toEqual(["i1"]);
    // 件数は可視項目から再計算(total=1, done=1)。保存済みの全体値は返さない。
    expect(p.counts.total).toBe(1);
    expect(p.counts.done).toBe(1);
    expect(p.counts.failed).toBe(0);
  });
});
