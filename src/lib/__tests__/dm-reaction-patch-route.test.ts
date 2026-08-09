/**
 * PATCH /api/properties/[id]/dm-logs/[logId]/reaction(手動反響)の統合テスト。
 * 設計書§3:
 *  - property:write + record scope + tx 親行ロック。403 は fail-closed(DB 不触)
 *  - status は allowlist(4種)・reactedAt は実在日のみ 422・未来日 400
 *  - terminal(refused/undeliverable)を書くときは Owner FOR UPDATE が親行ロックより先(R47)
 *  - ブリッジ行(draftId あり)は保存直後に同一 tx で syncSaleDmReaction(R32/R40)
 *  - undeliverable 連動: dmStatus=no_send+dmUndeliverableAt / 訂正で残数ゼロなら解除
 *  - 監査 dm_reaction_update {logId,status,reactedAt}(note 非掲載・sanitize 素通り)
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { Prisma } from "@/generated/prisma";

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

vi.mock("@/lib/property-record-guard", () => ({
  assertPropertyRecordAccess: vi.fn(),
  lockPropertyRecordForWrite: vi.fn(),
}));

// ロック順(Owner→親→子)は呼び出し順で検証するため mock。
vi.mock("@/lib/dm-batch/locks", () => ({
  lockOwnersForUpdate: vi.fn(),
}));

vi.mock("@/lib/dm-reaction/sync", () => {
  class SyncOwnerSetChangedError extends Error {}
  return { syncSaleDmReaction: vi.fn(), SyncOwnerSetChangedError };
});

vi.mock("@/lib/dm-reaction/reconcile", () => ({
  reconcileLegacySaleDmLog: vi.fn(),
}));

vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    propertyDmLog: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    dmRecipientDraft: { count: vi.fn() },
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
import { lockOwnersForUpdate } from "@/lib/dm-batch/locks";
import { syncSaleDmReaction } from "@/lib/dm-reaction/sync";
import { reconcileLegacySaleDmLog } from "@/lib/dm-reaction/reconcile";
import { writeAuditLog } from "@/lib/audit";
import { sanitizeAuditDetail } from "@/lib/audit-log-detail-safety";
import { PATCH } from "../../app/api/properties/[id]/dm-logs/[logId]/reaction/route";

const pm = prisma as unknown as {
  propertyDmLog: { findFirst: Mock; findUnique: Mock; update: Mock; count: Mock };
  dmRecipientDraft: { count: Mock };
  property: { update: Mock };
  $transaction: Mock;
};

const PERMS_WRITE = [
  { resource: "property", action: "read", granted: true },
  { resource: "property", action: "write", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "owner_note", action: "edit", granted: true },
];

const PROP_ID = "0p000000-0000-4000-8000-000000000001";
const LOG_ID = "01000000-0000-4000-8000-000000000001";
const OWNER_1 = "0a000000-0000-4000-8000-000000000001";
const OWNER_2 = "0a000000-0000-4000-8000-000000000002";
const DRAFT_ID = "0d000000-0000-4000-8000-000000000001";

function patchRequest(body: unknown) {
  return new Request(
    `http://localhost/api/properties/${PROP_ID}/dm-logs/${LOG_ID}/reaction`,
    {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    },
  ) as unknown as import("next/server").NextRequest;
}
const ctx = { params: Promise.resolve({ id: PROP_ID, logId: LOG_ID }) };

function baseLog(over: Record<string, unknown> = {}) {
  return {
    id: LOG_ID,
    ownerId: OWNER_1,
    draftId: null,
    method: "mail",
    reactionStatus: "no_response",
    reactedAt: null,
    reactionNote: null,
    reactionSource: null,
    manualReactionShadow: null,
    logOwners: [{ ownerId: OWNER_2 }],
    ...over,
  };
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
  vi.mocked(lockOwnersForUpdate).mockResolvedValue(undefined);
  vi.mocked(syncSaleDmReaction).mockResolvedValue(undefined);
  pm.propertyDmLog.findFirst.mockResolvedValue(baseLog());
  pm.propertyDmLog.findUnique.mockResolvedValue({
    reactionStatus: "replied",
    reactedAt: new Date("2026-08-01T00:00:00Z"),
    reactionSource: "manual",
  });
  pm.propertyDmLog.update.mockResolvedValue({});
  pm.propertyDmLog.count.mockResolvedValue(0);
  pm.dmRecipientDraft.count.mockResolvedValue(0);
  pm.property.update.mockResolvedValue({});
});

describe("PATCH .../dm-logs/[logId]/reaction(手動反響)", () => {
  it("property:write 欠如は 403(fail-closed・DB 不触)", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(
      PERMS_WRITE.filter((p) => p.action !== "write") as never,
    );
    const res = await PATCH(patchRequest({ status: "replied" }), ctx);
    expect(res.status).toBe(403);
    expect(assertPropertyRecordAccess).not.toHaveBeenCalled();
    expect(pm.propertyDmLog.update).not.toHaveBeenCalled();
  });

  it("allowlist 外の status は 422", async () => {
    const res = await PATCH(patchRequest({ status: "angry" }), ctx);
    expect(res.status).toBe(422);
    expect(pm.propertyDmLog.update).not.toHaveBeenCalled();
  });

  it("実在しない日付(2026-99-99)は 422・未来日は 400", async () => {
    const res1 = await PATCH(
      patchRequest({ status: "replied", reactedAt: "2026-99-99" }),
      ctx,
    );
    expect(res1.status).toBe(422);
    const future = new Date(Date.now() + 9 * 3600 * 1000 + 86400 * 1000)
      .toISOString()
      .slice(0, 10);
    const res2 = await PATCH(
      patchRequest({ status: "replied", reactedAt: future }),
      ctx,
    );
    expect(res2.status).toBe(400);
    expect(pm.propertyDmLog.update).not.toHaveBeenCalled();
  });

  it("物件スコープ外の log(findFirst 空振り)は 404", async () => {
    pm.propertyDmLog.findFirst.mockResolvedValue(null);
    const res = await PATCH(patchRequest({ status: "replied" }), ctx);
    expect(res.status).toBe(404);
    expect(pm.propertyDmLog.findFirst.mock.calls[0][0].where).toEqual({
      id: LOG_ID,
      propertyId: PROP_ID,
    });
  });

  it("terminal(refused)は Owner FOR UPDATE(代表+連関全員)→親行ロック→更新の順(R47)", async () => {
    pm.propertyDmLog.findUnique.mockResolvedValue({
      reactionStatus: "refused",
      reactedAt: null,
      reactionSource: "manual",
    });
    const res = await PATCH(patchRequest({ status: "refused" }), ctx);
    expect(res.status).toBe(200);
    const lockCall = vi.mocked(lockOwnersForUpdate).mock.calls[0];
    expect([...(lockCall[1] as string[])].sort()).toEqual(
      [OWNER_1, OWNER_2].sort(),
    );
    const ownerLockOrder =
      vi.mocked(lockOwnersForUpdate).mock.invocationCallOrder[0];
    const parentLockOrder =
      vi.mocked(lockPropertyRecordForWrite).mock.invocationCallOrder[0];
    const updateOrder = pm.propertyDmLog.update.mock.invocationCallOrder[0];
    expect(ownerLockOrder).toBeLessThan(parentLockOrder);
    expect(parentLockOrder).toBeLessThan(updateOrder);
  });

  it("非 terminal(replied)の通常行は Owner ロックなし(ホットパス維持)", async () => {
    const res = await PATCH(patchRequest({ status: "replied" }), ctx);
    expect(res.status).toBe(200);
    expect(lockOwnersForUpdate).not.toHaveBeenCalled();
    expect(lockPropertyRecordForWrite).toHaveBeenCalled();
  });

  it("手動保存は applyManualReaction の形(source=manual・shadow クリア)で update される", async () => {
    await PATCH(
      patchRequest({ status: "replied", reactedAt: "2026-08-01", note: "電話あり" }),
      ctx,
    );
    const data = pm.propertyDmLog.update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      reactionStatus: "replied",
      reactionNote: "電話あり",
      reactionSource: "manual",
    });
    expect(data.reactedAt).toEqual(new Date("2026-08-01T00:00:00Z"));
    expect(data.manualReactionShadow).toBe(Prisma.DbNull);
  });

  it("note 省略は既存メモを保持(マスク表示値の往復で実メモを消さない=#366 R2)", async () => {
    pm.propertyDmLog.findFirst.mockResolvedValue(
      baseLog({ reactionNote: "実メモ(サーバ保存値)" }),
    );
    await PATCH(patchRequest({ status: "replied" }), ctx);
    const data = pm.propertyDmLog.update.mock.calls[0][0].data;
    expect(data.reactionNote).toBe("実メモ(サーバ保存値)");
  });

  it("note: null は明示的にメモを消す", async () => {
    pm.propertyDmLog.findFirst.mockResolvedValue(
      baseLog({ reactionNote: "実メモ" }),
    );
    await PATCH(patchRequest({ status: "replied", note: null }), ctx);
    const data = pm.propertyDmLog.update.mock.calls[0][0].data;
    expect(data.reactionNote).toBeNull();
  });

  it("owner_note の edit/full が無ければ note 付き保存は 403・note 省略なら 200(#366 R10)", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(
      PERMS_WRITE.filter((p) => p.resource !== "owner_note") as never,
    );
    // 見えないメモを上書き・消去できてしまうため、フィールドレベルで拒否
    const res1 = await PATCH(patchRequest({ status: "replied", note: "上書き" }), ctx);
    expect(res1.status).toBe(403);
    const res2 = await PATCH(patchRequest({ status: "replied", note: null }), ctx);
    expect(res2.status).toBe(403);
    expect(pm.propertyDmLog.update).not.toHaveBeenCalled();
    // 反響種別・日付だけの記録は従来どおり可能(メモは保持される)
    const res3 = await PATCH(patchRequest({ status: "replied" }), ctx);
    expect(res3.status).toBe(200);
  });

  it("ロック後の再読取で所有者集合が変わっていたら 409・書き込まない(名寄せレース=#366 R2)", async () => {
    pm.propertyDmLog.findFirst
      .mockResolvedValueOnce(baseLog()) // 先読み: OWNER_1+OWNER_2 をロック
      .mockResolvedValueOnce(
        baseLog({ ownerId: "0a000000-0000-4000-8000-000000000009" }),
      ); // ロック後: 名寄せで master へ付け替え済み
    const res = await PATCH(patchRequest({ status: "refused" }), ctx);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("もう一度");
    expect(pm.propertyDmLog.update).not.toHaveBeenCalled();
  });

  it("ブリッジ行(draftId あり)は保存直後に同一 tx で syncSaleDmReaction・Owner ロックも取る", async () => {
    pm.propertyDmLog.findFirst.mockResolvedValue(baseLog({ draftId: DRAFT_ID }));
    const res = await PATCH(patchRequest({ status: "no_response" }), ctx);
    expect(res.status).toBe(200);
    // 再導出が terminal を書き得るため、非 terminal の手動保存でも Owner を先にロック
    expect(lockOwnersForUpdate).toHaveBeenCalled();
    expect(syncSaleDmReaction).toHaveBeenCalledWith(expect.anything(), DRAFT_ID);
    expect(
      pm.propertyDmLog.update.mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(syncSaleDmReaction).mock.invocationCallOrder[0]);
  });

  it("通常行(draftId なし)は syncSaleDmReaction を呼ばない", async () => {
    await PATCH(patchRequest({ status: "replied" }), ctx);
    expect(syncSaleDmReaction).not.toHaveBeenCalled();
    expect(reconcileLegacySaleDmLog).not.toHaveBeenCalled();
  });

  it("旧 sale_dm 行(draftId なし)は照合フォールバックを再適用・Owner ロックも取る", async () => {
    const sentAt = new Date("2026-07-01T00:00:00Z");
    pm.propertyDmLog.findFirst.mockResolvedValue(
      baseLog({ method: "sale_dm", draftId: null, sentAt }),
    );
    const res = await PATCH(patchRequest({ status: "no_response" }), ctx);
    expect(res.status).toBe(200);
    // 照合が terminal(宛先不明)を書き得るため、非 terminal の手動保存でも Owner を先にロック
    expect(lockOwnersForUpdate).toHaveBeenCalled();
    expect(reconcileLegacySaleDmLog).toHaveBeenCalledWith(expect.anything(), {
      id: LOG_ID,
      propertyId: PROP_ID,
      sentAt,
    });
    expect(syncSaleDmReaction).not.toHaveBeenCalled();
    // 手動保存 → 照合の順
    expect(
      pm.propertyDmLog.update.mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(reconcileLegacySaleDmLog).mock.invocationCallOrder[0],
    );
  });

  it("undeliverable 連動: dmStatus=no_send + dmUndeliverableAt(親行ロック保持中)", async () => {
    pm.propertyDmLog.findUnique.mockResolvedValue({
      reactionStatus: "undeliverable",
      reactedAt: null,
      reactionSource: "manual",
    });
    const res = await PATCH(patchRequest({ status: "undeliverable" }), ctx);
    expect(res.status).toBe(200);
    const upd = pm.property.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: PROP_ID });
    expect(upd.data.dmStatus).toBe("no_send");
    expect(upd.data.dmUndeliverableAt).toBeInstanceOf(Date);
    const body = (await res.json()) as { undeliverableLinked: boolean };
    expect(body.undeliverableLinked).toBe(true);
  });

  it("undeliverable からの訂正: 残数ゼロなら dmUndeliverableAt=null(dmStatus は据え置き)", async () => {
    pm.propertyDmLog.findFirst.mockResolvedValue(
      baseLog({ reactionStatus: "undeliverable", reactionSource: "manual" }),
    );
    pm.propertyDmLog.findUnique.mockResolvedValue({
      reactionStatus: "replied",
      reactedAt: null,
      reactionSource: "manual",
    });
    const res = await PATCH(patchRequest({ status: "replied" }), ctx);
    expect(res.status).toBe(200);
    const upd = pm.property.update.mock.calls[0][0];
    expect(upd.data).toEqual({ dmUndeliverableAt: null });
    const body = (await res.json()) as { undeliverableCleared: boolean };
    expect(body.undeliverableCleared).toBe(true);
    // 残数の数え方: 自分以外の undeliverable ログ+returned_undeliverable の sent ドラフト
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
  });

  it("undeliverable からの訂正でも残数があれば解除しない", async () => {
    pm.propertyDmLog.findFirst.mockResolvedValue(
      baseLog({ reactionStatus: "undeliverable", reactionSource: "manual" }),
    );
    pm.propertyDmLog.findUnique.mockResolvedValue({
      reactionStatus: "replied",
      reactedAt: null,
      reactionSource: "manual",
    });
    pm.dmRecipientDraft.count.mockResolvedValue(1);
    const res = await PATCH(patchRequest({ status: "replied" }), ctx);
    expect(res.status).toBe(200);
    expect(pm.property.update).not.toHaveBeenCalled();
    const body = (await res.json()) as { undeliverableCleared: boolean };
    expect(body.undeliverableCleared).toBe(false);
  });

  it("監査 dm_reaction_update {logId,status,reactedAt}(note 本文は載せない)", async () => {
    await PATCH(
      patchRequest({ status: "refused", reactedAt: "2026-08-01", note: "もう送るな" }),
      ctx,
    );
    const audit = vi.mocked(writeAuditLog).mock.calls.at(-1)?.[0] as {
      action: string;
      detail: Record<string, unknown>;
    };
    expect(audit.action).toBe("dm_reaction_update");
    expect(audit.detail).toEqual({
      logId: LOG_ID,
      status: "refused",
      reactedAt: "2026-08-01",
    });
    expect(JSON.stringify(audit.detail)).not.toContain("もう送るな");
  });
});

describe("監査キー登録(ACTION_EXTRA_KEYS)", () => {
  it("dm_reaction_update の detail キーが sanitize で残る", () => {
    const out = sanitizeAuditDetail("dm_reaction_update", {
      logId: "l1",
      status: "refused",
      reactedAt: "2026-08-01",
    }) as Record<string, unknown>;
    expect(out).toEqual({
      logId: "l1",
      status: "refused",
      reactedAt: "2026-08-01",
    });
  });
});
