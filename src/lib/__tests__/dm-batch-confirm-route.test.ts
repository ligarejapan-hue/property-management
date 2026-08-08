/**
 * POST /api/properties/dm-batches/[id]/confirm(送付確定)+ GET 一覧の統合テスト。
 * 設計書§2.2:
 *  - 確定は downloadedAt 必須(未DLは 409)
 *  - sentOn は「初回DLの JST 暦日以降〜今日以前」(境界値含む)
 *  - field_staff は自分の控えのみ(他人は 404)・スコープ外 item ありは 403 で全体拒否
 *  - 冪等: confirmedAt=null の updateMany 勝者のみログ生成・二重確定 409
 *  - ロック順: Owner FOR SHARE→物件 FOR UPDATE→バッチ updateMany→items FOR UPDATE
 *  - 生成行: dmType=owner_address/batchId/sentAt=sentOn/method=mail+連関コピー・
 *    DL後の owner 削除 item は ownerId=null で記録(R42)
 *  - 監査 dm_sent_confirm {batchId,count,sentOn}
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
      if (error instanceof Error && error.constructor.name === "ZodError") {
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
    dmExportBatch: { findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    dmExportBatchItem: { findMany: vi.fn() },
    property: { findMany: vi.fn() },
    propertyDmLog: { createMany: vi.fn() },
    propertyDmLogOwner: { createMany: vi.fn() },
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  db.$queryRaw = vi.fn(async () => []);
  return { default: db };
});

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { POST } from "../../app/api/properties/dm-batches/[id]/confirm/route";
import { GET as LIST } from "../../app/api/properties/dm-batches/route";

const pm = prisma as unknown as {
  dmExportBatch: { findUnique: Mock; findMany: Mock; updateMany: Mock };
  dmExportBatchItem: { findMany: Mock };
  property: { findMany: Mock };
  propertyDmLog: { createMany: Mock };
  propertyDmLogOwner: { createMany: Mock };
  $transaction: Mock;
  $queryRaw: Mock;
};

const PERMS_FULL = [
  { resource: "property", action: "read", granted: true },
  { resource: "property", action: "write", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "csv_export", action: "read", granted: true },
  { resource: "csv_export_personal", action: "read", granted: true },
];

const BATCH_ID = "0b000000-0000-4000-8000-000000000002";

function makeItemRow(over: Record<string, unknown> = {}) {
  return {
    id: "i1",
    propertyId: "p1",
    ownerId: "o1",
    itemOwners: [{ ownerId: "o1" }, { ownerId: "o2" }],
    ...over,
  };
}

function makeRequest(body: unknown) {
  return new Request(
    `http://localhost/api/properties/dm-batches/${BATCH_ID}/confirm`,
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    },
  ) as unknown as import("next/server").NextRequest;
}
const ctx = { params: Promise.resolve({ id: BATCH_ID }) };

/** JST の今日/昨日相当の文字列(+9h 平行移動)。 */
function jstDateString(offsetDays = 0): string {
  return new Date(Date.now() + 9 * 3600 * 1000 + offsetDays * 86400 * 1000)
    .toISOString()
    .slice(0, 10);
}

function rawSqlCalls(): string[] {
  return pm.$queryRaw.mock.calls.map((c) =>
    Array.isArray(c[0])
      ? (c[0] as string[]).join("?").replace(/\s+/g, " ")
      : String(c[0]),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApiSession).mockResolvedValue({
    id: "user-admin",
    role: "admin",
  } as never);
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL as never);
  pm.dmExportBatch.findUnique.mockResolvedValue({
    id: BATCH_ID,
    createdBy: "user-admin",
    downloadedAt: new Date(Date.now() - 86400 * 1000), // 昨日DL済み
    confirmedAt: null,
  });
  pm.dmExportBatch.updateMany.mockResolvedValue({ count: 1 });
  pm.dmExportBatch.findMany.mockResolvedValue([]);
  pm.dmExportBatchItem.findMany.mockResolvedValue([makeItemRow()]);
  pm.property.findMany.mockResolvedValue([
    { id: "p1", createdBy: "user-admin", assignedTo: null },
  ]);
  pm.propertyDmLog.createMany.mockResolvedValue({ count: 1 });
  pm.propertyDmLogOwner.createMany.mockResolvedValue({ count: 2 });
  pm.$queryRaw.mockResolvedValue([]);
});

describe("POST /api/properties/dm-batches/[id]/confirm", () => {
  it("未DL(downloadedAt null)の確定は 409", async () => {
    pm.dmExportBatch.findUnique.mockResolvedValue({
      id: BATCH_ID,
      createdBy: "user-admin",
      downloadedAt: null,
      confirmedAt: null,
    });
    const res = await POST(makeRequest({ sentOn: jstDateString() }), ctx);
    expect(res.status).toBe(409);
    expect(pm.propertyDmLog.createMany).not.toHaveBeenCalled();
  });

  it("実在しない日付(2026-02-31)は 422(#364 R1)", async () => {
    const res = await POST(makeRequest({ sentOn: "2026-02-31" }), ctx);
    expect(res.status).toBe(422);
    expect(pm.propertyDmLog.createMany).not.toHaveBeenCalled();
  });

  it("sentOn が初回DLの JST 暦日より前は 400・未来日も 400", async () => {
    const res1 = await POST(makeRequest({ sentOn: jstDateString(-3) }), ctx);
    expect(res1.status).toBe(400);
    const res2 = await POST(makeRequest({ sentOn: jstDateString(1) }), ctx);
    expect(res2.status).toBe(400);
    expect(pm.propertyDmLog.createMany).not.toHaveBeenCalled();
  });

  it("DL当日(境界値)の sentOn は受理する", async () => {
    pm.dmExportBatch.findUnique.mockResolvedValue({
      id: BATCH_ID,
      createdBy: "user-admin",
      downloadedAt: new Date(),
      confirmedAt: null,
    });
    const res = await POST(makeRequest({ sentOn: jstDateString() }), ctx);
    expect(res.status).toBe(200);
  });

  it("property:write 欠如は 403(fail-closed)", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(
      PERMS_FULL.filter(
        (p) => !(p.resource === "property" && p.action === "write"),
      ) as never,
    );
    const res = await POST(makeRequest({ sentOn: jstDateString() }), ctx);
    expect(res.status).toBe(403);
    expect(pm.dmExportBatch.findUnique).not.toHaveBeenCalled();
  });

  it("field_staff は他人の控えを確定できない(404)", async () => {
    vi.mocked(getApiSession).mockResolvedValue({
      id: "user-field",
      role: "field_staff",
    } as never);
    const res = await POST(makeRequest({ sentOn: jstDateString() }), ctx);
    expect(res.status).toBe(404);
  });

  it("field_staff: スコープ外 item が1件でもあれば 403(件数入りメッセージ・全体拒否)", async () => {
    vi.mocked(getApiSession).mockResolvedValue({
      id: "user-field",
      role: "field_staff",
    } as never);
    pm.dmExportBatch.findUnique.mockResolvedValue({
      id: BATCH_ID,
      createdBy: "user-field",
      downloadedAt: new Date(),
      confirmedAt: null,
    });
    pm.property.findMany.mockResolvedValue([
      { id: "p1", createdBy: "someone-else", assignedTo: null },
    ]);
    const res = await POST(makeRequest({ sentOn: jstDateString() }), ctx);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("1 件");
    expect(pm.propertyDmLog.createMany).not.toHaveBeenCalled();
  });

  it("二重確定(updateMany 敗者)は 409・ログを作らない", async () => {
    pm.dmExportBatch.updateMany.mockResolvedValue({ count: 0 });
    const res = await POST(makeRequest({ sentOn: jstDateString() }), ctx);
    expect(res.status).toBe(409);
    expect(pm.propertyDmLog.createMany).not.toHaveBeenCalled();
  });

  it("成功: ロック順(Owner FOR SHARE→物件 FOR UPDATE→items FOR UPDATE)・生成行・連関コピー・監査", async () => {
    const sentOn = jstDateString();
    const res = await POST(makeRequest({ sentOn }), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { confirmed: number };
    expect(body.confirmed).toBe(1);
    const sqls = rawSqlCalls();
    expect(sqls[0]).toMatch(/FROM owners .*FOR SHARE/);
    expect(sqls[1]).toMatch(/FROM properties .*FOR UPDATE/);
    expect(sqls[2]).toMatch(/FROM dm_export_batch_items .*FOR UPDATE/);
    // updateMany(勝者決定)が物件ロックの後
    const upd = pm.dmExportBatch.updateMany.mock.calls[0][0];
    expect(upd.where).toEqual({ id: BATCH_ID, confirmedAt: null });
    expect(upd.data.sentOn).toEqual(new Date(`${sentOn}T00:00:00Z`));
    // 生成行
    const logs = pm.propertyDmLog.createMany.mock.calls[0][0].data;
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      propertyId: "p1",
      ownerId: "o1",
      dmType: "owner_address",
      batchId: BATCH_ID,
      draftId: null,
      method: "mail",
      sentBy: "user-admin",
    });
    expect(logs[0].sentAt).toEqual(new Date(`${sentOn}T00:00:00Z`));
    // 連関コピー(グループ全員)
    const links = pm.propertyDmLogOwner.createMany.mock.calls[0][0].data;
    expect(links.map((l: { ownerId: string }) => l.ownerId).sort()).toEqual([
      "o1",
      "o2",
    ]);
    expect(links[0].logId).toBe(logs[0].id);
    // 監査
    const audit = vi.mocked(writeAuditLog).mock.calls.at(-1)?.[0] as {
      action: string;
      detail: Record<string, unknown>;
    };
    expect(audit.action).toBe("dm_sent_confirm");
    expect(audit.detail).toMatchObject({ batchId: BATCH_ID, count: 1, sentOn });
  });

  it("DL後に owner が消えた item は ownerId=null で記録する(R42)", async () => {
    pm.dmExportBatchItem.findMany.mockResolvedValue([
      makeItemRow({ id: "i-null", ownerId: null, itemOwners: [{ ownerId: "o2" }] }),
    ]);
    const res = await POST(makeRequest({ sentOn: jstDateString() }), ctx);
    expect(res.status).toBe(200);
    const logs = pm.propertyDmLog.createMany.mock.calls[0][0].data;
    expect(logs[0].ownerId).toBeNull();
    // 残っている連関はコピーされる(所有者横断の除外が効き続ける)
    const links = pm.propertyDmLogOwner.createMany.mock.calls[0][0].data;
    expect(links.map((l: { ownerId: string }) => l.ownerId)).toEqual(["o2"]);
  });
});

describe("GET /api/properties/dm-batches?unconfirmed=1", () => {
  function listRequest(qs = "?unconfirmed=1") {
    return new Request(
      `http://localhost/api/properties/dm-batches${qs}`,
    ) as unknown as import("next/server").NextRequest;
  }

  it("未確定のみ・0件バッチ除外・ページング(+1件先読み)・宛先PIIなしの select", async () => {
    pm.dmExportBatch.findMany.mockResolvedValue([
      {
        id: "b1",
        createdAt: new Date(),
        rowCount: 12,
        downloadedAt: new Date(),
        confirmedAt: null,
        createdBy: "user-admin",
        creator: { name: "管理 太郎" },
      },
    ]);
    const res = await LIST(listRequest());
    expect(res.status).toBe(200);
    const arg = pm.dmExportBatch.findMany.mock.calls[0][0];
    expect(arg.where.confirmedAt).toBeNull();
    expect(arg.where.rowCount).toEqual({ gt: 0 }); // 0件バッチは確定不能=一覧に出さない(#364 R2)
    expect(arg.take).toBe(51); // 50件+hasMore判定の先読み1件
    // 宛先(所有者)のPIIは select しない。creator.name はスタッフ名=非PII(表示用)。
    expect(JSON.stringify(arg.select)).not.toMatch(/address|zip|owner/i);
    const body = (await res.json()) as { data: Array<{ creatorName: string }>; hasMore: boolean };
    expect(body.data[0].creatorName).toBe("管理 太郎");
    expect(body.hasMore).toBe(false);
  });

  it("51件返ると hasMore=true・50件に切って返す", async () => {
    pm.dmExportBatch.findMany.mockResolvedValue(
      Array.from({ length: 51 }, (_, i) => ({
        id: `b${i}`,
        createdAt: new Date(),
        rowCount: 1,
        downloadedAt: null,
        confirmedAt: null,
        createdBy: "user-admin",
        creator: { name: "A" },
      })),
    );
    const res = await LIST(listRequest());
    const body = (await res.json()) as { data: unknown[]; hasMore: boolean };
    expect(body.data).toHaveLength(50);
    expect(body.hasMore).toBe(true);
  });

  it("field_staff は自分の控えのみ・admin は全員分", async () => {
    vi.mocked(getApiSession).mockResolvedValue({
      id: "user-field",
      role: "field_staff",
    } as never);
    await LIST(listRequest());
    expect(
      pm.dmExportBatch.findMany.mock.calls[0][0].where.createdBy,
    ).toBe("user-field");

    vi.mocked(getApiSession).mockResolvedValue({
      id: "user-admin",
      role: "admin",
    } as never);
    await LIST(listRequest());
    expect(
      pm.dmExportBatch.findMany.mock.calls[1][0].where.createdBy,
    ).toBeUndefined();
  });

  it("csv_export:read 欠如は 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(
      PERMS_FULL.filter((p) => p.resource !== "csv_export") as never,
    );
    const res = await LIST(listRequest());
    expect(res.status).toBe(403);
    expect(pm.dmExportBatch.findMany).not.toHaveBeenCalled();
  });
});
