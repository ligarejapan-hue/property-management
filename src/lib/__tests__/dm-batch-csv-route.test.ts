/**
 * GET /api/properties/dm-batches/[id]/csv(控えからのCSVダウンロード)の統合テスト。
 * 設計書§2.1「初回ダウンロードを境界とするライフサイクル」:
 *  - 作成者本人以外は 404 / 4権限+表示レベルは fail-closed 403
 *  - 初回GET: ロック順(Owner FOR SHARE→物件 FOR SHARE→バッチ FOR UPDATE)→検証→凍結
 *    (downloadedAt+csvDigest+rowCount 再計算)・null item の物理削除
 *  - 資格検査: 送付不能(hold等)409 / スコープ欠け403 / グループ不一致409
 *  - 再試行GET: digest 一致のみ配信・不一致 409・資格検査は毎回
 *  - 監査 property_dm_csv_export(成功時のみ・非PII)
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
  };
});

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    dmExportBatch: { findFirst: vi.fn(), update: vi.fn() },
    dmExportBatchItem: { findMany: vi.fn(), deleteMany: vi.fn() },
    property: { findMany: vi.fn() },
    importJobRow: { findMany: vi.fn() },
    propertyDmLog: { findMany: vi.fn(async () => []) },
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
import { GET } from "../../app/api/properties/dm-batches/[id]/csv/route";

const pm = prisma as unknown as {
  dmExportBatch: { findFirst: Mock; update: Mock };
  dmExportBatchItem: { findMany: Mock; deleteMany: Mock };
  property: { findMany: Mock };
  importJobRow: { findMany: Mock };
  propertyDmLog: { findMany: Mock };
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

const BATCH_ID = "0b000000-0000-4000-8000-000000000001";

function makeItemRow(over: Record<string, unknown> = {}) {
  return {
    id: "i1",
    propertyId: "p1",
    ownerId: "o1",
    itemOwners: [{ ownerId: "o1" }],
    ...over,
  };
}

function makePropRow(over: Record<string, unknown> = {}) {
  return {
    id: "p1",
    dmStatus: "send",
    isArchived: false,
    createdBy: "user-admin",
    assignedTo: null,
    address: "東京都千代田区1-1",
    propertyType: "land",
    propertyOwners: [
      {
        isPrimary: true,
        relationship: "本人",
        owner: {
          id: "o1",
          name: "所有 花子",
          nameKana: null,
          zip: "100-0001",
          address: "東京都千代田区2-2",
          corporateNumber: null,
        },
      },
    ],
    ...over,
  };
}

/** $queryRaw を SQL 内容で振り分ける(owners/properties ロックは[]・バッチ行は指定値)。 */
function armQueryRaw(batchRow: Record<string, unknown> | null) {
  pm.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    const sql = Array.isArray(strings) ? strings.join("?") : String(strings);
    if (sql.includes("dm_export_batches")) {
      return batchRow ? [batchRow] : [];
    }
    return [];
  });
}

function rawSqlCalls(): string[] {
  return pm.$queryRaw.mock.calls.map((c) =>
    Array.isArray(c[0]) ? (c[0] as string[]).join("?").replace(/\s+/g, " ") : String(c[0]),
  );
}

function makeRequest() {
  return new Request(
    `http://localhost/api/properties/dm-batches/${BATCH_ID}/csv`,
  ) as unknown as import("next/server").NextRequest;
}
const ctx = { params: Promise.resolve({ id: BATCH_ID }) };

async function readCsv(res: Response): Promise<string> {
  const buf = new Uint8Array(await res.arrayBuffer());
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf);
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
  pm.dmExportBatch.findFirst.mockResolvedValue({ id: BATCH_ID });
  pm.dmExportBatch.update.mockResolvedValue({});
  pm.dmExportBatchItem.findMany.mockResolvedValue([makeItemRow()]);
  pm.dmExportBatchItem.deleteMany.mockResolvedValue({ count: 0 });
  pm.property.findMany.mockResolvedValue([makePropRow()]);
  pm.importJobRow.findMany.mockResolvedValue([]);
  pm.propertyDmLog.findMany.mockResolvedValue([]);
  armQueryRaw({
    id: BATCH_ID,
    downloaded_at: null,
    csv_digest: null,
    resend_filter_applied: false,
  });
});

describe("GET /api/properties/dm-batches/[id]/csv", () => {
  it("作成者本人以外(findFirst 空振り)は 404・tx に入らない", async () => {
    pm.dmExportBatch.findFirst.mockResolvedValue(null);
    const res = await GET(makeRequest(), ctx);
    expect(res.status).toBe(404);
    expect(pm.$transaction).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("権限欠如は 403・DB 未読(fail-closed)", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(
      PERMS_FULL.filter((p) => p.resource !== "csv_export_personal") as never,
    );
    const res = await GET(makeRequest(), ctx);
    expect(res.status).toBe(403);
    expect(pm.dmExportBatch.findFirst).not.toHaveBeenCalled();
  });

  it("初回GET成功: ロック順(Owner→物件→バッチ)→CSV配信→凍結(downloadedAt+digest+rowCount)", async () => {
    const res = await GET(makeRequest(), ctx);
    expect(res.status).toBe(200);
    const csv = await readCsv(res);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain("所有 花子");
    // ロック順: owners FOR SHARE → properties FOR SHARE → dm_export_batches FOR UPDATE
    const sqls = rawSqlCalls();
    expect(sqls[0]).toMatch(/FROM owners .*FOR SHARE/);
    expect(sqls[1]).toMatch(/FROM properties .*FOR SHARE/);
    expect(sqls[2]).toMatch(/FROM dm_export_batches .*FOR UPDATE/);
    // 凍結
    const upd = pm.dmExportBatch.update.mock.calls[0][0];
    expect(upd.data.downloadedAt).toBeInstanceOf(Date);
    expect(upd.data.csvDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(upd.data.rowCount).toBe(1);
    // ヘッダ
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    // 監査(成功時のみ)
    const audit = vi.mocked(writeAuditLog).mock.calls.at(-1)?.[0] as {
      action: string;
      detail: Record<string, unknown>;
    };
    expect(audit.action).toBe("property_dm_csv_export");
    expect(audit.detail.retry).toBe(false);
    expect(JSON.stringify(audit.detail)).not.toMatch(/花子|千代田/);
  });

  it("初回GET: owner 削除で null の item は物理削除して rowCount 再計算(R45)", async () => {
    pm.dmExportBatchItem.findMany.mockResolvedValue([
      makeItemRow(),
      makeItemRow({ id: "i-null", ownerId: null, itemOwners: [] }),
    ]);
    const res = await GET(makeRequest(), ctx);
    expect(res.status).toBe(200);
    expect(pm.dmExportBatchItem.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["i-null"] } },
    });
    expect(pm.dmExportBatch.update.mock.calls[0][0].data.rowCount).toBe(1);
  });

  it("初回GET: dmStatus=hold の物件が混ざると 409・凍結しない(R48/R52)", async () => {
    pm.property.findMany.mockResolvedValue([makePropRow({ dmStatus: "hold" })]);
    const res = await GET(makeRequest(), ctx);
    expect(res.status).toBe(409);
    expect(pm.dmExportBatch.update).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("初回GET: グループ構成が変わったら 409(R51)", async () => {
    pm.property.findMany.mockResolvedValue([
      makePropRow({
        propertyOwners: [
          {
            isPrimary: true,
            relationship: null,
            owner: { id: "o1", name: "所有 花子", nameKana: null, zip: "100-0001", address: "東京都千代田区2-2", corporateNumber: null },
          },
          {
            isPrimary: false,
            relationship: null,
            owner: { id: "o2", name: "共有 次郎", nameKana: null, zip: "100-0001", address: "東京都千代田区2-2", corporateNumber: null },
          },
        ],
      }),
    ]);
    const res = await GET(makeRequest(), ctx);
    expect(res.status).toBe(409);
    expect(pm.dmExportBatch.update).not.toHaveBeenCalled();
  });

  it("field_staff のスコープ欠けは 403(R44)", async () => {
    vi.mocked(getApiSession).mockResolvedValue({
      id: "user-field",
      role: "field_staff",
    } as never);
    const res = await GET(makeRequest(), ctx);
    expect(res.status).toBe(403);
    expect(pm.dmExportBatch.update).not.toHaveBeenCalled();
  });

  it("初回GET: 拒否・宛先不明の反響が付いた宛先が混ざると 409・凍結しない(検査(2)=R42/PR-B)", async () => {
    // 他物件も含む所有者横断の terminal 反響(代表 or 連関経由)を検出する
    pm.propertyDmLog.findMany.mockResolvedValue([
      { ownerId: "o1", logOwners: [] },
    ]);
    const res = await GET(makeRequest(), ctx);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("拒否・宛先不明");
    expect(pm.dmExportBatch.update).not.toHaveBeenCalled();
    // 検出クエリ: terminal 2種のみ・代表(owner_id)/連関(log_owners)/所有者なし記録の物件単位の3経路
    const where = pm.propertyDmLog.findMany.mock.calls[0][0].where;
    expect(where.reactionStatus).toEqual({ in: ["refused", "undeliverable"] });
    expect(where.OR).toEqual([
      { ownerId: { in: ["o1"] } },
      { logOwners: { some: { ownerId: { in: ["o1"] } } } },
      { propertyId: { in: ["p1"] }, ownerId: null, logOwners: { none: {} } },
    ]);
  });

  it("初回GET: 所有者紐づけの無い terminal 記録(個別記録の拒否)は物件単位で 409(#366 R6)", async () => {
    pm.propertyDmLog.findMany.mockResolvedValue([
      { ownerId: null, propertyId: "p1", logOwners: [] },
    ]);
    const res = await GET(makeRequest(), ctx);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("拒否・宛先不明");
  });

  it("初回GET: 連関(共有者)経由の terminal 反響も 409(代表だけ見ない=R29)", async () => {
    pm.dmExportBatchItem.findMany.mockResolvedValue([
      makeItemRow({ itemOwners: [{ ownerId: "o1" }, { ownerId: "o2" }] }),
    ]);
    pm.property.findMany.mockResolvedValue([
      makePropRow({
        propertyOwners: [
          ...makePropRow().propertyOwners,
          {
            isPrimary: false,
            relationship: null,
            owner: {
              id: "o2",
              name: "共有 太郎",
              nameKana: null,
              zip: "100-0001",
              address: "東京都千代田区2-2",
              corporateNumber: null,
            },
          },
        ],
      }),
    ]);
    // 共有者 o2 に別物件で拒否の記録(連関経由)
    pm.propertyDmLog.findMany.mockResolvedValue([
      { ownerId: null, logOwners: [{ ownerId: "o2" }] },
    ]);
    const res = await GET(makeRequest(), ctx);
    expect(res.status).toBe(409);
  });

  it("再試行GET: terminal 反響検査は毎回掛かる(初回DL後の拒否は digest 一致でも 409=R45/R53)", async () => {
    // 初回DLで実 digest を確定(digest 不一致による偽の 409 と区別するため)
    const res1 = await GET(makeRequest(), ctx);
    expect(res1.status).toBe(200);
    const digest = pm.dmExportBatch.update.mock.calls[0][0].data.csvDigest;
    armQueryRaw({
      id: BATCH_ID,
      downloaded_at: new Date(),
      csv_digest: digest,
      resend_filter_applied: false,
    });
    // 初回DL後に拒否の反響が付いた
    pm.propertyDmLog.findMany.mockResolvedValue([
      { ownerId: "o1", logOwners: [] },
    ]);
    const res2 = await GET(makeRequest(), ctx);
    expect(res2.status).toBe(409);
    const body = (await res2.json()) as { error: { message: string } };
    expect(body.error.message).toContain("拒否・宛先不明");
  });

  it("再試行GET: digest 一致なら 200・凍結の再書き込みはしない(R43)", async () => {
    // 1回目(初回)で digest を確定 → 2回目(再試行)で同じ内容
    const res1 = await GET(makeRequest(), ctx);
    expect(res1.status).toBe(200);
    const digest = pm.dmExportBatch.update.mock.calls[0][0].data.csvDigest;
    vi.mocked(writeAuditLog).mockClear();
    pm.dmExportBatch.update.mockClear();
    armQueryRaw({
      id: BATCH_ID,
      downloaded_at: new Date(),
      csv_digest: digest,
      resend_filter_applied: false,
    });
    const res2 = await GET(makeRequest(), ctx);
    expect(res2.status).toBe(200);
    expect(pm.dmExportBatch.update).not.toHaveBeenCalled();
    const audit = vi.mocked(writeAuditLog).mock.calls.at(-1)?.[0] as {
      detail: Record<string, unknown>;
    };
    expect(audit.detail.retry).toBe(true);
  });

  it("再試行GET: 内容が変わって digest 不一致なら 409(R43)", async () => {
    armQueryRaw({
      id: BATCH_ID,
      downloaded_at: new Date(),
      csv_digest: "0".repeat(64), // 保存済み digest と一致しない
      resend_filter_applied: false,
    });
    const res = await GET(makeRequest(), ctx);
    expect(res.status).toBe(409);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("再試行GET: 資格検査は毎回掛かる(hold 化した宛先が混ざれば 409=R45/R53)", async () => {
    armQueryRaw({
      id: BATCH_ID,
      downloaded_at: new Date(),
      csv_digest: "x".repeat(64),
      resend_filter_applied: false,
    });
    pm.property.findMany.mockResolvedValue([makePropRow({ dmStatus: "no_send" })]);
    const res = await GET(makeRequest(), ctx);
    expect(res.status).toBe(409);
  });

  it("再試行GET: DL後の owner 削除(null item)は 409・物理削除しない(R42)", async () => {
    armQueryRaw({
      id: BATCH_ID,
      downloaded_at: new Date(),
      csv_digest: "x".repeat(64),
      resend_filter_applied: false,
    });
    pm.dmExportBatchItem.findMany.mockResolvedValue([
      makeItemRow(),
      makeItemRow({ id: "i-null", ownerId: null, itemOwners: [] }),
    ]);
    const res = await GET(makeRequest(), ctx);
    expect(res.status).toBe(409);
    expect(pm.dmExportBatchItem.deleteMany).not.toHaveBeenCalled();
  });
});

describe("GET /api/properties/dm-batches/[id]/csv: 再送候補の再評価(検査(5)=PR-C)", () => {
  const RESEND_BATCH = {
    id: BATCH_ID,
    downloaded_at: null,
    csv_digest: null,
    resend_filter_applied: true,
  };

  /**
   * propertyDmLog.findMany を**クエリの内容で**振り分ける。
   * ⚠呼び出し順(mockResolvedValueOnce)で組むと、検査(5)が走らないケースで
   * 2つ目の once が消費されずに次のテストへ漏れる(実際に踏んだ)。
   */
  function armDmLogs(opts: { terminal?: unknown[]; recent?: unknown[] } = {}) {
    pm.propertyDmLog.findMany.mockImplementation(
      async (args: { where?: Record<string, unknown> }) =>
        args?.where?.sentAt ? (opts.recent ?? []) : (opts.terminal ?? []),
    );
  }

  it("再送候補由来の控えは、作成後に送付が入った宛先があれば 409・凍結しない", async () => {
    armQueryRaw(RESEND_BATCH);
    armDmLogs({ recent: [{ propertyId: "p1" }] });
    const res = await GET(makeRequest(), ctx);
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { message: string; code: string };
    };
    expect(body.error.code).toBe("RESEND_STALE");
    expect(pm.dmExportBatch.update).not.toHaveBeenCalled();
    // 検査(5)のクエリは cutoff より新しい送付だけを引く(反響の条件は付けない)
    const call = pm.propertyDmLog.findMany.mock.calls.find(
      (c) => (c[0] as { where?: Record<string, unknown> })?.where?.sentAt,
    );
    expect(call).toBeDefined();
    const where = (
      call![0] as {
        where: {
          propertyId?: { in: string[] };
          sentAt?: { gt: Date };
          reactionStatus?: unknown;
        };
      }
    ).where;
    expect(where.propertyId).toEqual({ in: ["p1"] });
    expect(where.sentAt?.gt).toBeInstanceOf(Date);
    expect(where.reactionStatus).toBeUndefined();
  });

  it("再送候補由来でない控えは検査(5)のクエリ自体を出さない(既存の挙動を変えない)", async () => {
    armDmLogs();
    const res = await GET(makeRequest(), ctx);
    expect(res.status).toBe(200);
    expect(pm.propertyDmLog.findMany).toHaveBeenCalledTimes(1);
  });

  it("再送候補由来でも、期間内の送付が無ければ通常どおり配信する", async () => {
    armQueryRaw(RESEND_BATCH);
    armDmLogs();
    const res = await GET(makeRequest(), ctx);
    expect(res.status).toBe(200);
    expect(pm.propertyDmLog.findMany).toHaveBeenCalledTimes(2);
  });
});
