/**
 * POST /api/properties/[id]/dm-logs(個別記録)+ DELETE .../dm-logs/[logId](取消)の統合テスト。
 * 設計書§2.3:
 *  - property:write + record scope(assertPropertyRecordAccess)+ tx 先頭の親行ロック
 *  - sentOn は過去日可・今日(JST)以前のみ(未来 400)・method allowlist 外は 422
 *  - 作成行は ownerId/dmType/batchId/draftId = null(所有者宛バッチと区別)
 *  - DELETE: sale_dm 行は 409・他物件の log は 404
 *  - 監査 dm_sent_record {propertyId,sentOn} / dm_sent_record_delete {logId}(note 非掲載)
 *  - property_dm_log_view の viewedAt が sanitize で残る(既存バグ修正の回帰ピン)
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

// 親行ロック規約は実物 property-record-guard を使わず、呼び出し順を検証するために mock。
vi.mock("@/lib/property-record-guard", () => ({
  assertPropertyRecordAccess: vi.fn(),
  lockPropertyRecordForWrite: vi.fn(),
}));

vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    propertyDmLog: {
      create: vi.fn(),
      findFirst: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(async () => 0),
    },
    dmRecipientDraft: { count: vi.fn(async () => 0) },
    property: { update: vi.fn() },
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  db.$queryRaw = vi.fn(async () => []);
  return { default: db };
});

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import {
  assertPropertyRecordAccess,
  lockPropertyRecordForWrite,
} from "@/lib/property-record-guard";
import { writeAuditLog } from "@/lib/audit";
import { sanitizeAuditDetail } from "@/lib/audit-log-detail-safety";
import { POST } from "../../app/api/properties/[id]/dm-logs/route";
import { DELETE } from "../../app/api/properties/[id]/dm-logs/[logId]/route";

const pm = prisma as unknown as {
  propertyDmLog: { create: Mock; findFirst: Mock; delete: Mock; count: Mock };
  dmRecipientDraft: { count: Mock };
  property: { update: Mock };
  $transaction: Mock;
};

const PERMS_WRITE = [
  { resource: "property", action: "read", granted: true },
  { resource: "property", action: "write", granted: true },
  { resource: "owner", action: "read", granted: true },
];

const PROP_ID = "0p000000-0000-4000-8000-000000000001";
const LOG_ID = "01000000-0000-4000-8000-000000000001";

function postRequest(body: unknown) {
  return new Request(`http://localhost/api/properties/${PROP_ID}/dm-logs`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  }) as unknown as import("next/server").NextRequest;
}
const postCtx = { params: Promise.resolve({ id: PROP_ID }) };

function deleteRequest() {
  return new Request(
    `http://localhost/api/properties/${PROP_ID}/dm-logs/${LOG_ID}`,
    { method: "DELETE" },
  ) as unknown as import("next/server").NextRequest;
}
const deleteCtx = { params: Promise.resolve({ id: PROP_ID, logId: LOG_ID }) };

function jstToday(offsetDays = 0): string {
  return new Date(Date.now() + 9 * 3600 * 1000 + offsetDays * 86400 * 1000)
    .toISOString()
    .slice(0, 10);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApiSession).mockResolvedValue({
    id: "user-1",
    role: "office_staff",
  } as never);
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS_WRITE as never);
  vi.mocked(assertPropertyRecordAccess).mockResolvedValue(undefined);
  vi.mocked(lockPropertyRecordForWrite).mockResolvedValue(undefined);
  pm.propertyDmLog.create.mockResolvedValue({ id: LOG_ID });
  pm.propertyDmLog.findFirst.mockResolvedValue({
    id: LOG_ID,
    method: "mail",
    batchId: null,
    reactionStatus: "no_response",
  });
  pm.propertyDmLog.delete.mockResolvedValue({});
  pm.property.update.mockResolvedValue({});
});

describe("POST /api/properties/[id]/dm-logs(個別記録)", () => {
  it("property:write 欠如は 403(fail-closed)", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(
      PERMS_WRITE.filter((p) => p.action !== "write") as never,
    );
    const res = await POST(postRequest({ sentOn: jstToday() }), postCtx);
    expect(res.status).toBe(403);
    expect(assertPropertyRecordAccess).not.toHaveBeenCalled();
    expect(pm.propertyDmLog.create).not.toHaveBeenCalled();
  });

  it("実在しない日付(2026-99-99)は 422(#364 R1)", async () => {
    const res = await POST(postRequest({ sentOn: "2026-99-99" }), postCtx);
    expect(res.status).toBe(422);
    expect(pm.propertyDmLog.create).not.toHaveBeenCalled();
  });

  it("未来日は 400・method allowlist 外は 422", async () => {
    const res1 = await POST(postRequest({ sentOn: jstToday(1) }), postCtx);
    expect(res1.status).toBe(400);
    const res2 = await POST(
      postRequest({ sentOn: jstToday(), method: "fax" }),
      postCtx,
    );
    expect(res2.status).toBe(422);
    expect(pm.propertyDmLog.create).not.toHaveBeenCalled();
  });

  it("過去日は受理・作成行は ownerId/dmType/batchId/draftId=null・親行ロックが create より先", async () => {
    const res = await POST(
      postRequest({ sentOn: "2026-08-01", method: "hand_delivery", note: "現地で手渡し" }),
      postCtx,
    );
    expect(res.status).toBe(201);
    // record scope + 親行ロック規約
    expect(assertPropertyRecordAccess).toHaveBeenCalledWith(
      PROP_ID,
      expect.anything(),
      "write",
    );
    expect(vi.mocked(lockPropertyRecordForWrite).mock.invocationCallOrder[0])
      .toBeLessThan(pm.propertyDmLog.create.mock.invocationCallOrder[0]);
    const data = pm.propertyDmLog.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      propertyId: PROP_ID,
      ownerId: null,
      dmType: null,
      batchId: null,
      draftId: null,
      method: "hand_delivery",
      note: "現地で手渡し",
      sentBy: "user-1",
    });
    expect(data.sentAt).toEqual(new Date("2026-08-01T00:00:00Z"));
    // 監査(note 本文は載せない)
    const audit = vi.mocked(writeAuditLog).mock.calls.at(-1)?.[0] as {
      action: string;
      detail: Record<string, unknown>;
    };
    expect(audit.action).toBe("dm_sent_record");
    expect(audit.detail).toEqual({ propertyId: PROP_ID, sentOn: "2026-08-01" });
    expect(JSON.stringify(audit.detail)).not.toContain("手渡し");
  });
});

describe("DELETE /api/properties/[id]/dm-logs/[logId](取消)", () => {
  it("一括確定(batchId あり)の行は 409・削除しない(#364 R3)", async () => {
    pm.propertyDmLog.findFirst.mockResolvedValue({
      id: LOG_ID,
      method: "mail",
      batchId: "batch-1",
    });
    const res = await DELETE(deleteRequest(), deleteCtx);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("一括確定");
    expect(pm.propertyDmLog.delete).not.toHaveBeenCalled();
  });

  it("sale_dm 行は 409(売却DM画面へ誘導)・削除しない", async () => {
    pm.propertyDmLog.findFirst.mockResolvedValue({
      id: LOG_ID,
      method: "sale_dm",
      batchId: null,
    });
    const res = await DELETE(deleteRequest(), deleteCtx);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("売却DM");
    expect(pm.propertyDmLog.delete).not.toHaveBeenCalled();
  });

  it("他物件の log(propertyId 不一致=findFirst 空振り)は 404", async () => {
    pm.propertyDmLog.findFirst.mockResolvedValue(null);
    const res = await DELETE(deleteRequest(), deleteCtx);
    expect(res.status).toBe(404);
    // 物件スコープで引いている(logId 単独で辿れない)
    expect(pm.propertyDmLog.findFirst.mock.calls[0][0].where).toEqual({
      id: LOG_ID,
      propertyId: PROP_ID,
    });
  });

  it("成功: 親行ロック→削除→監査 dm_sent_record_delete", async () => {
    const res = await DELETE(deleteRequest(), deleteCtx);
    expect(res.status).toBe(200);
    expect(vi.mocked(lockPropertyRecordForWrite).mock.invocationCallOrder[0])
      .toBeLessThan(pm.propertyDmLog.delete.mock.invocationCallOrder[0]);
    const audit = vi.mocked(writeAuditLog).mock.calls.at(-1)?.[0] as {
      action: string;
      detail: Record<string, unknown>;
    };
    expect(audit.action).toBe("dm_sent_record_delete");
    expect(audit.detail).toEqual({ logId: LOG_ID });
  });

  it("宛先不明(undeliverable)反響付き行の削除: 残数ゼロなら dmUndeliverableAt=null(PR-B・親行ロック保持)", async () => {
    pm.propertyDmLog.findFirst.mockResolvedValue({
      id: LOG_ID,
      method: "mail",
      batchId: null,
      reactionStatus: "undeliverable",
    });
    const res = await DELETE(deleteRequest(), deleteCtx);
    expect(res.status).toBe(200);
    // 残数の数え方: 自分以外の宛先不明ログ+returned_undeliverable の sent ドラフト
    expect(pm.propertyDmLog.count.mock.calls[0][0].where).toMatchObject({
      propertyId: PROP_ID,
      reactionStatus: "undeliverable",
      id: { not: LOG_ID },
    });
    expect(pm.dmRecipientDraft.count.mock.calls[0][0].where).toMatchObject({
      propertyId: PROP_ID,
      status: "sent",
      deliveryStatus: "returned_undeliverable",
    });
    const upd = pm.property.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: PROP_ID });
    expect(upd.data).toEqual({ dmUndeliverableAt: null });
  });

  it("宛先不明反響付き行の削除でも残数があれば物件フラグを消さない", async () => {
    pm.propertyDmLog.findFirst.mockResolvedValue({
      id: LOG_ID,
      method: "mail",
      batchId: null,
      reactionStatus: "undeliverable",
    });
    pm.dmRecipientDraft.count.mockResolvedValueOnce(1);
    const res = await DELETE(deleteRequest(), deleteCtx);
    expect(res.status).toBe(200);
    expect(pm.property.update).not.toHaveBeenCalled();
  });

  it("宛先不明でない行の削除は再計算しない(物件を触らない)", async () => {
    const res = await DELETE(deleteRequest(), deleteCtx);
    expect(res.status).toBe(200);
    expect(pm.propertyDmLog.count).not.toHaveBeenCalled();
    expect(pm.property.update).not.toHaveBeenCalled();
  });
});

describe("監査キー登録(ACTION_EXTRA_KEYS)", () => {
  it("property_dm_log_view の viewedAt が [REDACTED] にならない(既存バグ修正)", () => {
    const out = sanitizeAuditDetail("property_dm_log_view", {
      count: 3,
      total: 10,
      page: 1,
      viewedAt: "2026-08-08T10:00:00.000Z",
    }) as Record<string, unknown>;
    expect(out.viewedAt).toBe("2026-08-08T10:00:00.000Z");
    expect(out.count).toBe(3);
  });

  it("dm_sent_confirm / dm_sent_record / dm_sent_record_delete の detail キーが残る", () => {
    const confirm = sanitizeAuditDetail("dm_sent_confirm", {
      batchId: "b1",
      count: 5,
      sentOn: "2026-08-08",
    }) as Record<string, unknown>;
    expect(confirm).toEqual({ batchId: "b1", count: 5, sentOn: "2026-08-08" });
    const record = sanitizeAuditDetail("dm_sent_record", {
      propertyId: "p1",
      sentOn: "2026-08-08",
    }) as Record<string, unknown>;
    expect(record).toEqual({ propertyId: "p1", sentOn: "2026-08-08" });
    const del = sanitizeAuditDetail("dm_sent_record_delete", {
      logId: "l1",
    }) as Record<string, unknown>;
    expect(del).toEqual({ logId: "l1" });
  });
});

// 「拒否」が付いた記録の取消は管理者のみ(発注者指示 2026-08-17)。削除を許すと
// 「拒否→変更は管理者のみ」の縛りが素通りになる(消して記録し直せば外せる)。
describe("DELETE: 拒否付き記録の取消は管理者のみ", () => {
  it("office_staff → 403 REFUSED_DELETE_ADMIN_ONLY・削除なし", async () => {
    pm.propertyDmLog.findFirst.mockResolvedValue({
      id: LOG_ID, method: "mail", batchId: null, reactionStatus: "refused",
    });
    const res = await DELETE(deleteRequest(), deleteCtx);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error.code).toBe("REFUSED_DELETE_ADMIN_ONLY");
    expect(pm.propertyDmLog.delete).not.toHaveBeenCalled();
  });

  it("admin は取り消せる(200)", async () => {
    vi.mocked(getApiSession).mockResolvedValue({ id: "u1", role: "admin" } as never);
    pm.propertyDmLog.findFirst.mockResolvedValue({
      id: LOG_ID, method: "mail", batchId: null, reactionStatus: "refused",
    });
    pm.propertyDmLog.count.mockResolvedValue(0);
    pm.dmRecipientDraft.count.mockResolvedValue(0);
    const res = await DELETE(deleteRequest(), deleteCtx);
    expect(res.status).toBe(200);
  });
});
