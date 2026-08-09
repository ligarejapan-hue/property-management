/**
 * POST /api/properties/dm-batches(宛名CSV出力の控え作成)の統合テスト。
 * 旧 GET /api/properties/dm-export のピンを2段階フローの POST 側へ引き継ぐ:
 *  - dmStatus=send / isArchived=false のサーバ側強制(hold/no_send 指定は無視)
 *  - 4権限それぞれの 403(fail-closed: DB取得・控え作成・監査なし)
 *  - 表示レベル(name/zip/address)が生値でなければ 403
 *  - 管理ID切り捨て/取得物件数/最終グループ行数の上限 400
 *  - PropertyDmLog にはどの段でも書かない(送付記録は確定APIのみ)
 * 新規ピン:
 *  - 控え(バッチ+items+共有者連関)を書く・rowCount=グループ数
 *  - attemptKey 冪等(未確定=reused / 確定済み=409)
 *  - 監査 dm_batch_create(PIIなし)・batch.filters は allowlist キーのみ
 * CSV のバイト列・敬称・ヘッダは GET csv 側(dm-batch-csv-route.test.ts)と
 * lib テスト(dm-export.test.ts / dm-batch/csv.test.ts)で担保する。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response {
    static json = (b: unknown, init?: ResponseInit) => Response.json(b, init);
  }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
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
      Response.json(data as object, { status }),
    ),
    handleApiError: vi.fn((error: unknown) => {
      if (error instanceof MockApiError) {
        return Response.json(
          { error: { message: error.message, code: error.code } },
          { status: error.status },
        );
      }
      if (
        error instanceof Error &&
        error.constructor.name === "ZodError"
      ) {
        return Response.json(
          { error: { message: error.message, code: "VALIDATION" } },
          { status: 422 },
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

vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    property: { findMany: vi.fn(), count: vi.fn() },
    propertyOwner: { count: vi.fn(), findMany: vi.fn() },
    importJobRow: { findMany: vi.fn() },
    dmExportBatch: { create: vi.fn(), findFirst: vi.fn() },
    dmExportBatchItem: { createMany: vi.fn() },
    dmExportBatchItemOwner: { createMany: vi.fn() },
    // 送付記録は確定APIのみが書く。POST では一切書かない(読取=terminal除外のみ)。
    propertyDmLog: {
      create: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(async () => []),
    },
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  db.$queryRaw = vi.fn(async () => []);
  return { default: db };
});

import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { POST } from "../../app/api/properties/dm-batches/route";

const pm = prisma as unknown as {
  property: { findMany: Mock; count: Mock };
  propertyOwner: { count: Mock; findMany: Mock };
  importJobRow: { findMany: Mock };
  dmExportBatch: { create: Mock; findFirst: Mock };
  dmExportBatchItem: { createMany: Mock };
  dmExportBatchItemOwner: { createMany: Mock };
  propertyDmLog: { create: Mock; createMany: Mock; update: Mock; findMany: Mock };
  $transaction: Mock;
  $queryRaw: Mock;
};

const PERMS_FULL = [
  { resource: "property", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "csv_export", action: "read", granted: true },
  { resource: "csv_export_personal", action: "read", granted: true },
];

const FULL_DISPLAY = {
  name: "full",
  nameKana: "full",
  phone: "full",
  zip: "full",
  address: "full",
  note: "full",
  email: "full",
  corporateNumber: "full",
};

function makeOwner(over: Record<string, unknown> = {}) {
  return {
    id: "o1",
    name: "所有 花子",
    nameKana: "ショユウ ハナコ",
    zip: "100-0001",
    address: "東京都千代田区2-2",
    corporateNumber: null,
    ...over,
  };
}

function makePropertyOwner(over: Record<string, unknown> = {}) {
  const { owner, ...rest } = over;
  return {
    isPrimary: true,
    relationship: "本人",
    ...rest,
    owner: makeOwner((owner as Record<string, unknown>) ?? {}),
  };
}

function makeProp(over: Record<string, unknown> = {}) {
  return {
    id: "p1",
    address: "東京都千代田区1-1",
    propertyType: "land",
    propertyOwners: [makePropertyOwner()],
    ...over,
  };
}

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/properties/dm-batches", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  }) as unknown as import("next/server").NextRequest;
}

const BODY = { filters: {}, attemptKey: "attempt-key-0001" };

function lastAudit() {
  return vi.mocked(writeAuditLog).mock.calls.at(-1)?.[0] as
    | { action: string; detail?: Record<string, unknown> }
    | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApiSession).mockResolvedValue({
    id: "user-admin",
    email: "a@a",
    name: "A",
    role: "admin",
  } as never);
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL as never);
  vi.mocked(getOwnerDisplayConfig).mockResolvedValue(FULL_DISPLAY as never);
  pm.property.findMany.mockResolvedValue([]);
  pm.property.count.mockResolvedValue(0);
  pm.propertyOwner.count.mockResolvedValue(0);
  // tx 内のリンク再検証(#364 R7)用: 既定 fixture(p1×o1,o2)のリンクは健在。
  pm.propertyOwner.findMany.mockResolvedValue([
    { propertyId: "p1", ownerId: "o1" },
    { propertyId: "p1", ownerId: "o2" },
  ]);
  pm.importJobRow.findMany.mockResolvedValue([]);
  pm.dmExportBatch.findFirst.mockResolvedValue(null);
  pm.propertyDmLog.findMany.mockResolvedValue([]);
  pm.dmExportBatch.create.mockResolvedValue({ id: "b1" });
  pm.dmExportBatchItem.createMany.mockResolvedValue({ count: 0 });
  pm.dmExportBatchItemOwner.createMany.mockResolvedValue({ count: 0 });
  pm.$queryRaw.mockResolvedValue([]);
});

describe("POST /api/properties/dm-batches", () => {
  it("dmStatus=send / isArchived=false をサーバ側で強制する(hold 指定は無視)", async () => {
    const res = await POST(makeRequest({ ...BODY, filters: { dmStatus: "hold" } }));
    expect(res.status).toBe(200);
    const arg = pm.property.findMany.mock.calls[0][0];
    expect(arg.where.dmStatus).toBe("send");
    expect(arg.where.isArchived).toBe(false);
  });

  it.each([
    ["property", "read"],
    ["csv_export", "read"],
    ["csv_export_personal", "read"],
    ["owner", "read"],
  ])("%s:%s 欠如で 403(DB取得・控え作成・監査なし)", async (resource) => {
    vi.mocked(getUserPermissions).mockResolvedValue(
      PERMS_FULL.filter((p) => p.resource !== resource) as never,
    );
    const res = await POST(makeRequest(BODY));
    expect(res.status).toBe(403);
    expect(pm.property.findMany).not.toHaveBeenCalled();
    expect(pm.dmExportBatch.create).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("表示レベルが生値でなければ 403(副作用なし)", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValue({
      ...FULL_DISPLAY,
      address: "masked",
    } as never);
    const res = await POST(makeRequest(BODY));
    expect(res.status).toBe(403);
    expect(pm.property.findMany).not.toHaveBeenCalled();
    expect(pm.dmExportBatch.create).not.toHaveBeenCalled();
  });

  it("控え(バッチ+items+共有者連関)を書き、PropertyDmLog は書かない", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({
        propertyOwners: [
          makePropertyOwner({
            owner: { id: "o1", name: "親 太郎", zip: "100-0001", address: "東京都港区3-3" },
          }),
          makePropertyOwner({
            owner: { id: "o2", name: "子 次郎", zip: "100-0001", address: "東京都港区3-3" },
            isPrimary: false,
          }),
        ],
      }),
    ]);
    const res = await POST(makeRequest(BODY));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { batchId: string; rowCount: number };
    expect(body.batchId).toBeTruthy();
    expect(body.rowCount).toBe(1); // 同一住所グループ=1通
    const batchData = pm.dmExportBatch.create.mock.calls[0][0].data;
    expect(batchData.dmType).toBe("owner_address");
    expect(batchData.rowCount).toBe(1);
    expect(batchData.attemptKey).toBe(BODY.attemptKey);
    const itemsData = pm.dmExportBatchItem.createMany.mock.calls[0][0].data;
    expect(itemsData).toHaveLength(1);
    expect(itemsData[0].ownerId).toBe("o1"); // 代表(isPrimary)
    const linkData = pm.dmExportBatchItemOwner.createMany.mock.calls[0][0].data;
    expect(linkData.map((d: { ownerId: string }) => d.ownerId).sort()).toEqual([
      "o1",
      "o2",
    ]);
    expect(pm.propertyDmLog.create).not.toHaveBeenCalled();
    expect(pm.propertyDmLog.createMany).not.toHaveBeenCalled();
    expect(pm.propertyDmLog.update).not.toHaveBeenCalled();
  });

  it("別住所の共有者は別 item(rowCount=2)", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({
        propertyOwners: [
          makePropertyOwner({ owner: { id: "o1", address: "東京都A" } }),
          makePropertyOwner({
            owner: { id: "o2", address: "神奈川県B" },
            isPrimary: false,
          }),
        ],
      }),
    ]);
    const res = await POST(makeRequest(BODY));
    const body = (await res.json()) as { rowCount: number };
    expect(body.rowCount).toBe(2);
  });

  it("拒否・宛先不明の反響が付いた宛先グループは控え作成時に自動除外する(#366 R4)", async () => {
    // 拒否は物件の dmStatus を変えないため、DL 時の検査(2)だけだと再出力が恒久 409 になる。
    pm.property.findMany.mockResolvedValue([
      makeProp({
        propertyOwners: [
          makePropertyOwner({ owner: { id: "o1", address: "東京都A" } }),
          makePropertyOwner({
            owner: { id: "o2", address: "神奈川県B" },
            isPrimary: false,
          }),
        ],
      }),
    ]);
    // o2 に他物件も含む拒否の記録(所有者横断)
    pm.propertyDmLog.findMany.mockResolvedValue([
      { ownerId: "o2", logOwners: [] },
    ]);
    const res = await POST(makeRequest(BODY));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rowCount: number;
      excludedTerminalCount: number;
    };
    expect(body.rowCount).toBe(1); // o2 のグループが除外される
    expect(body.excludedTerminalCount).toBe(1);
    // 保存も除外後(rowCount・items とも)
    expect(pm.dmExportBatch.create.mock.calls[0][0].data.rowCount).toBe(1);
    const itemsData = pm.dmExportBatchItem.createMany.mock.calls[0][0].data;
    expect(itemsData).toHaveLength(1);
    expect(itemsData[0].ownerId).toBe("o1");
    // 検出クエリ: terminal 2種のみ・代表と連関の両経路
    const where = pm.propertyDmLog.findMany.mock.calls[0][0].where;
    expect(where.reactionStatus).toEqual({ in: ["refused", "undeliverable"] });
    expect(where.OR).toEqual([
      { ownerId: { in: ["o1", "o2"] } },
      { logOwners: { some: { ownerId: { in: ["o1", "o2"] } } } },
    ]);
    // 監査にも除外数(非PII)
    const audit = lastAudit();
    expect(audit?.detail?.excludedTerminal).toBe(1);
    expect(audit?.detail?.count).toBe(1);
  });

  it("attemptKey 再POST: 未確定の既存バッチは reused=true・作り直さない", async () => {
    pm.dmExportBatch.findFirst.mockResolvedValue({
      id: "b-exist",
      rowCount: 5,
      confirmedAt: null,
    });
    const res = await POST(makeRequest(BODY));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { batchId: string; reused: boolean };
    expect(body.batchId).toBe("b-exist");
    expect(body.reused).toBe(true);
    expect(pm.property.findMany).not.toHaveBeenCalled();
    expect(pm.dmExportBatch.create).not.toHaveBeenCalled();
  });

  it("attemptKey 再POST: 確定済みバッチは 409", async () => {
    pm.dmExportBatch.findFirst.mockResolvedValue({
      id: "b-exist",
      rowCount: 5,
      confirmedAt: new Date(),
    });
    const res = await POST(makeRequest(BODY));
    expect(res.status).toBe(409);
    expect(pm.dmExportBatch.create).not.toHaveBeenCalled();
  });

  it("並行 POST の敗者(tx 内 FOR UPDATE で既存検出)は勝者の控えを返す", async () => {
    pm.property.findMany.mockResolvedValue([makeProp()]);
    pm.$queryRaw.mockResolvedValue([{ id: "b-winner", confirmed_at: null }]);
    pm.dmExportBatch.findFirst
      .mockResolvedValueOnce(null) // 速路は空振り
      .mockResolvedValueOnce({ id: "b-winner", rowCount: 1, confirmedAt: null });
    const res = await POST(makeRequest(BODY));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { batchId: string; reused: boolean };
    expect(body.batchId).toBe("b-winner");
    expect(body.reused).toBe(true);
    expect(pm.dmExportBatch.create).not.toHaveBeenCalled();
  });

  it("取得物件数が上限超なら 400(控えを作らない)", async () => {
    const many = Array.from({ length: 10001 }, (_, i) =>
      makeProp({ id: `p${i}` }),
    );
    pm.property.findMany.mockResolvedValue(many);
    const res = await POST(makeRequest(BODY));
    expect(res.status).toBe(400);
    expect(pm.dmExportBatch.create).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("監査 dm_batch_create: detail は非PII(owner/name/address 系キーなし)", async () => {
    pm.property.findMany.mockResolvedValue([makeProp()]);
    const res = await POST(makeRequest(BODY));
    expect(res.status).toBe(200);
    const audit = lastAudit();
    expect(audit?.action).toBe("dm_batch_create");
    const keys = JSON.stringify(audit?.detail ?? {});
    expect(keys).not.toMatch(/name|address|zip|owner/i);
    expect(audit?.detail?.count).toBe(1);
  });

  it("batch.filters は allowlist キーのみ(keyword/mgmtId は保存しない)", async () => {
    pm.property.findMany.mockResolvedValue([makeProp()]);
    const res = await POST(
      makeRequest({
        ...BODY,
        filters: { propertyType: "land", keyword: "港区の田中さん" },
      }),
    );
    expect(res.status).toBe(200);
    const batchData = pm.dmExportBatch.create.mock.calls[0][0].data;
    expect(batchData.filters.propertyType).toBe("land");
    expect(batchData.filters.dmStatus).toBe("send");
    expect(JSON.stringify(batchData.filters)).not.toContain("田中");
    expect(batchData.filters.keyword).toBeUndefined();
  });

  it("attemptKey が短すぎる body は 422(zod)", async () => {
    const res = await POST(makeRequest({ filters: {}, attemptKey: "x" }));
    expect(res.status).toBe(422);
    expect(pm.property.findMany).not.toHaveBeenCalled();
  });

  it("冪等キーは作成者スコープ: 照会 where に createdBy が入る(#364 R1)", async () => {
    pm.property.findMany.mockResolvedValue([makeProp()]);
    const res = await POST(makeRequest(BODY));
    expect(res.status).toBe(200);
    // 速路の findFirst
    expect(pm.dmExportBatch.findFirst.mock.calls[0][0].where).toEqual({
      attemptKey: BODY.attemptKey,
      createdBy: "user-admin",
    });
    // tx 内 FOR UPDATE 照会にも created_by 条件が入る
    const sql = pm.$queryRaw.mock.calls
      .map((c: unknown[]) =>
        Array.isArray(c[0]) ? (c[0] as string[]).join("?").replace(/\s+/g, " ") : String(c[0]),
      )
      .find((q: string) => q.includes("dm_export_batches"));
    expect(sql).toContain("created_by");
  });

  it("控え保存前のリンク再検証: 名寄せ等で所有者が外れていたら 409(#364 R7)", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({
        propertyOwners: [
          makePropertyOwner({ owner: { id: "o1" } }),
          makePropertyOwner({ owner: { id: "o2" }, isPrimary: false }),
        ],
      }),
    ]);
    pm.propertyOwner.findMany.mockResolvedValue([
      { propertyId: "p1", ownerId: "o1" }, // o2 のリンクが tx 前に消えた(archive等)
    ]);
    const res = await POST(makeRequest(BODY));
    expect(res.status).toBe(409);
    expect(pm.dmExportBatch.create).not.toHaveBeenCalled();
    // ロック順: Owner FOR SHARE → 物件 FOR SHARE(名寄せの Owner 先頭ロックと同順)
    const sqls = pm.$queryRaw.mock.calls.map((c: unknown[]) =>
      Array.isArray(c[0]) ? (c[0] as string[]).join("?").replace(/\s+/g, " ") : String(c[0]),
    );
    const ownersIdx = sqls.findIndex((q: string) => q.includes("FROM owners"));
    const propsIdx = sqls.findIndex((q: string) => q.includes("FROM properties"));
    expect(ownersIdx).toBeGreaterThan(-1);
    expect(propsIdx).toBeGreaterThan(ownersIdx);
  });
});