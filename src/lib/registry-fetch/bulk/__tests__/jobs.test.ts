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
import { hashPropertyFingerprint } from "@/lib/registry-fetch/candidate-cache";

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
      // ⚠検索できる物件は「確認画面で見せた内容」の指紋が要る（@codex #373 R7 P1）。
      approvedFingerprints: {
        [P1]: hashPropertyFingerprint({
          address: "東京都A区1",
          lotNumber: "1",
          buildingNumber: null,
          realEstateNumber: null,
        }),
      },
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
      approvedFingerprints: {
        [P1]: hashPropertyFingerprint({
          address: "東京都A区1",
          lotNumber: "1",
          buildingNumber: null,
          realEstateNumber: null,
        }),
      },
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

// ---------------------------------------------------------------------------
// ⚠作成時に「検索に渡すもの一式」を控える（設計 §3.1.0.1）
// ---------------------------------------------------------------------------

describe("指紋の材料（設計 §3.1.0.1）", () => {
  it("住所だけ違えば違う指紋になる", async () => {
    // 番号が同じでも、処理時は住所も使って検索するので別の場所を探すことになる。
    const { hashPropertyFingerprint } = await import(
      "@/lib/registry-fetch/candidate-cache"
    );
    const a = hashPropertyFingerprint({
      address: "横浜市南区井土ケ谷中町",
      lotNumber: "69-2",
      buildingNumber: null,
      realEstateNumber: null,
    });
    const b = hashPropertyFingerprint({
      address: "横浜市南区別の町",
      lotNumber: "69-2",
      buildingNumber: null,
      realEstateNumber: null,
    });
    expect(a).not.toBe(b);
  });

  it("⚠同じ数字が地番から家屋番号へ移れば違う指紋になる（取りに行くものが変わる）", async () => {
    const { hashPropertyFingerprint } = await import(
      "@/lib/registry-fetch/candidate-cache"
    );
    const land = hashPropertyFingerprint({
      address: "A",
      lotNumber: "1-2",
      buildingNumber: null,
      realEstateNumber: null,
    });
    const building = hashPropertyFingerprint({
      address: "A",
      lotNumber: null,
      buildingNumber: "1-2",
      realEstateNumber: null,
    });
    expect(land).not.toBe(building);
  });

  it("⚠地番の値そのものをハッシュに残さない（秘匿）", async () => {
    const { hashPropertyFingerprint } = await import(
      "@/lib/registry-fetch/candidate-cache"
    );
    const h = hashPropertyFingerprint({
      address: "横浜市南区井土ケ谷中町",
      lotNumber: "69-2",
      buildingNumber: null,
      realEstateNumber: null,
    });
    expect(h).not.toContain("69");
    expect(h).toMatch(/^[0-9a-f]{32}$/);
  });
});

// ---------------------------------------------------------------------------
// ⚠承認した内容から変わっていたら作らない（@codex #373 R6 P1）
// ---------------------------------------------------------------------------

describe("承認の根拠（approvedFingerprints）", () => {
  /** 検索できる物件（住所+地番）。 */
  const prop = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    createdBy: "u1",
    assignedTo: null,
    address: "東京都A区1",
    lotNumber: "1" as string | null,
    buildingNumber: null as string | null,
    realEstateNumber: null as string | null,
    ...over,
  });
  const hashOf = (p: ReturnType<typeof prop>) =>
    hashPropertyFingerprint({
      address: p.address,
      lotNumber: p.lotNumber,
      buildingNumber: p.buildingNumber,
      realEstateNumber: p.realEstateNumber,
    });
  const itemsOf = () =>
    Object.fromEntries(
      (
        pm.registryFetchJobItem.createMany.mock.calls[0][0].data as Array<{
          propertyId: string;
          status: string;
          errorCode: string | null;
        }>
      ).map((i) => [i.propertyId, i]),
    );

  it("見せた内容と一致していれば pending", async () => {
    const p1 = prop(P1);
    pm.property.findMany.mockResolvedValue([p1]);
    const res = await createBulkFetchJob({
      session: STAFF,
      propertyIds: [P1],
      certificateType: "owner",
      approvedFingerprints: { [P1]: hashOf(p1) },
    });
    expect(res).toMatchObject({ pending: 1, skipped: 0 });
  });

  it("⚠見せた内容から変わっていたら、その物件だけ対象外にする", async () => {
    // 確認画面は「土地の登記を取得します」と見せて承認を取る。そこから作成までの間に
    // 家屋番号が足されると、作成時に読み直した新しい値で処理が進み、
    // **承認していない建物の登記を買う**。
    const p1 = prop(P1);
    const p2 = prop(P2, { address: "東京都B区2", lotNumber: "2" });
    pm.property.findMany.mockResolvedValue([p1, p2]);
    const res = await createBulkFetchJob({
      session: STAFF,
      propertyIds: [P1, P2],
      certificateType: "owner",
      approvedFingerprints: {
        // P1 は見せたあとに家屋番号が足された想定（＝現物と食い違う指紋）
        [P1]: hashOf(prop(P1, { buildingNumber: "12-3" })),
        [P2]: hashOf(p2),
      },
    });
    expect(res).toMatchObject({ pending: 1, skipped: 1 });
    const byId = itemsOf();
    expect(byId[P1]).toMatchObject({
      status: "skipped",
      errorCode: "identifier_changed",
    });
    expect(byId[P2].status).toBe("pending");
  });

  it("⚠指紋が付いていない物件は買わない（@codex #373 R7 P1）", async () => {
    // 古い画面のまま送信された / 確認の後で見えるようになった物件が混ざった場合。
    // 候補が1件なら処理は自動で購入まで進むので、通すと**見せていない対象を買う**。
    const p1 = prop(P1);
    const p2 = prop(P2, { address: "東京都B区2", lotNumber: "2" });
    pm.property.findMany.mockResolvedValue([p1, p2]);
    const res = await createBulkFetchJob({
      session: STAFF,
      propertyIds: [P1, P2],
      certificateType: "owner",
      approvedFingerprints: { [P1]: hashOf(p1) }, // P2 の分が無い
    });
    expect(res).toMatchObject({ pending: 1, skipped: 1 });
    const byId = itemsOf();
    expect(byId[P1].status).toBe("pending");
    expect(byId[P2]).toMatchObject({
      status: "skipped",
      errorCode: "not_approved",
    });
  });

  it("⚠指紋がまったく無ければ 1件も取りに行かない（後方互換より安全を採る）", async () => {
    pm.property.findMany.mockResolvedValue([prop(P1)]);
    await expect(
      createBulkFetchJob({
        session: STAFF,
        propertyIds: [P1],
        certificateType: "owner",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "REGISTRY_BULK_APPROVAL_STALE",
    });
    expect(pm.registryFetchJob.create).not.toHaveBeenCalled();
  });

  it("⚠承認が古くて全部対象外になったら、ジョブを作らない（@codex #373 R7 P2）", async () => {
    // 0件のジョブを作ると進捗画面へ飛ばされて即「完了」と出る＝何も取れていないのに
    // 終わったように見える。
    pm.property.findMany.mockResolvedValue([prop(P1)]);
    await expect(
      createBulkFetchJob({
        session: STAFF,
        propertyIds: [P1],
        certificateType: "owner",
        approvedFingerprints: { [P1]: "0".repeat(32) },
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "REGISTRY_BULK_APPROVAL_STALE",
    });
    expect(pm.registryFetchJob.create).not.toHaveBeenCalled();
  });

  it("⚠番号不足で0件になったときも作らない（設計 §3.1.0・@codex #373 R8 P2）", async () => {
    // ジョブ作成が許されるのは「1件でも対象が残るとき」だけ。
    pm.property.findMany.mockResolvedValue([
      prop(P1, { lotNumber: null, buildingNumber: null }),
    ]);
    await expect(
      createBulkFetchJob({
        session: STAFF,
        propertyIds: [P1],
        certificateType: "owner",
        approvedFingerprints: {},
      }),
    ).rejects.toMatchObject({ status: 409, code: "REGISTRY_BULK_NO_PENDING" });
    expect(pm.registryFetchJob.create).not.toHaveBeenCalled();
  });

  it("⚠断るときは理由の内訳を出す（進捗画面を見せられないので、ここで言うしかない）", async () => {
    pm.property.findMany.mockResolvedValue([
      prop(P1, { lotNumber: null, buildingNumber: null }),
      prop(P2, { address: null, lotNumber: null, buildingNumber: null }),
    ]);
    const err = await createBulkFetchJob({
      session: STAFF,
      propertyIds: [P1, P2],
      certificateType: "owner",
      approvedFingerprints: {},
    }).catch((e: Error) => e);
    expect((err as Error).message).toContain("地番・家屋番号が未入力: 1件");
    expect((err as Error).message).toContain("住所が未入力: 1件");
  });

  it("⚠断り文句に住所・地番の値そのものを載せない（秘匿）", async () => {
    pm.property.findMany.mockResolvedValue([
      prop(P1, { address: "横浜市南区井土ケ谷中町", lotNumber: "69-2", realEstateNumber: "0413234567890" }),
    ]);
    const err = await createBulkFetchJob({
      session: STAFF,
      propertyIds: [P1],
      certificateType: "owner",
      approvedFingerprints: {},
    }).catch((e: Error) => e);
    expect((err as Error).message).not.toContain("井土ケ谷");
    expect((err as Error).message).not.toContain("69-2");
    expect((err as Error).message).not.toContain("0413234567890");
  });

  it("⚠指紋の材料に地番の値そのものを残さない（秘匿）", async () => {
    const h = hashPropertyFingerprint({
      address: "横浜市南区井土ケ谷中町",
      lotNumber: "69-2",
      buildingNumber: null,
      realEstateNumber: null,
    });
    expect(h).not.toContain("69");
    expect(h).toMatch(/^[0-9a-f]{32}$/);
  });
});
