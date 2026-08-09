/**
 * /api/admin/orphan-dm-logs(孤児記録の管理・admin専用)の統合テスト。
 * 設計書§2.4・R51 P2:
 *  - 対象は propertyId=null の行のみ(それ以外 404)。物件削除で孤児化した拒否/宛先不明の
 *    訂正経路が無いと、その所有者の全物件が永久に再送候補から消えるため。
 *  - ゲート: user_management:read(admin データ補正ツールの慣例)+ GET は owner:read /
 *    PATCH・DELETE は property:write(反響・記録の書込と同じ)。
 *  - PATCH: terminal は Owner FOR UPDATE 先行(親行ロックは親が無いので無し=R47)。
 *  - DELETE: batchId/sale_dm 由来でも孤児は削除可(他に復元経路が無い)。
 *  - 監査は既存 action+detail orphan:true。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { readFileSync } from "fs";
import path from "path";
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
vi.mock("@/lib/dm-batch/locks", () => ({ lockOwnersForUpdate: vi.fn() }));

vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    propertyDmLog: {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      findFirst: vi.fn(),
      update: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
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
import { lockOwnersForUpdate } from "@/lib/dm-batch/locks";
import { writeAuditLog } from "@/lib/audit";
import { sanitizeAuditDetail } from "@/lib/audit-log-detail-safety";
import { GET } from "../../app/api/admin/orphan-dm-logs/route";
import { PATCH, DELETE } from "../../app/api/admin/orphan-dm-logs/[logId]/route";

const pm = prisma as unknown as {
  propertyDmLog: {
    findMany: Mock;
    count: Mock;
    findFirst: Mock;
    update: Mock;
    delete: Mock;
  };
  $transaction: Mock;
};

const PERMS_ADMIN = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "property", action: "write", granted: true },
];

const LOG_ID = "01000000-0000-4000-8000-000000000001";
const OWNER_1 = "0a000000-0000-4000-8000-000000000001";
const OWNER_2 = "0a000000-0000-4000-8000-000000000002";

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

function getRequest(qs = "") {
  return new Request(
    `http://localhost/api/admin/orphan-dm-logs${qs}`,
  ) as unknown as import("next/server").NextRequest;
}

function patchRequest(body: unknown) {
  return new Request(`http://localhost/api/admin/orphan-dm-logs/${LOG_ID}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  }) as unknown as import("next/server").NextRequest;
}

function deleteRequest() {
  return new Request(`http://localhost/api/admin/orphan-dm-logs/${LOG_ID}`, {
    method: "DELETE",
  }) as unknown as import("next/server").NextRequest;
}
const idCtx = { params: Promise.resolve({ logId: LOG_ID }) };

function orphanLog(over: Record<string, unknown> = {}) {
  return {
    id: LOG_ID,
    ownerId: OWNER_1,
    draftId: null,
    method: "mail",
    batchId: null,
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
    id: "admin-1",
    role: "admin",
  } as never);
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS_ADMIN as never);
  vi.mocked(getOwnerDisplayConfig).mockResolvedValue(FULL_DISPLAY as never);
  vi.mocked(lockOwnersForUpdate).mockResolvedValue(undefined);
  pm.propertyDmLog.findMany.mockResolvedValue([]);
  pm.propertyDmLog.count.mockResolvedValue(0);
  pm.propertyDmLog.findFirst.mockResolvedValue(orphanLog());
  pm.propertyDmLog.update.mockResolvedValue({});
  pm.propertyDmLog.delete.mockResolvedValue({});
});

describe("GET /api/admin/orphan-dm-logs(検索・一覧)", () => {
  it("user_management:read 欠如は 403(fail-closed・DB 不触)", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(
      PERMS_ADMIN.filter((p) => p.resource !== "user_management") as never,
    );
    const res = await GET(getRequest());
    expect(res.status).toBe(403);
    expect(pm.propertyDmLog.findMany).not.toHaveBeenCalled();
  });

  it("owner:read 欠如は 403(所有者名を返すため)", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(
      PERMS_ADMIN.filter((p) => p.resource !== "owner") as never,
    );
    const res = await GET(getRequest());
    expect(res.status).toBe(403);
    expect(pm.propertyDmLog.findMany).not.toHaveBeenCalled();
  });

  it("氏名がマスク表示のユーザーの氏名検索は 403(ヒット件数の名前当てオラクル封じ=S1a/#366 R7)", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValue({
      ...FULL_DISPLAY,
      name: "masked",
    } as never);
    const res = await GET(getRequest("?q=山田"));
    expect(res.status).toBe(403);
    expect(pm.propertyDmLog.findMany).not.toHaveBeenCalled();
  });

  it("氏名マスクでも q なしの一覧は 200(検索だけを塞ぐ)", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValue({
      ...FULL_DISPLAY,
      name: "masked",
    } as never);
    const res = await GET(getRequest());
    expect(res.status).toBe(200);
  });

  it("対象は propertyId=null の行のみ・所有者名検索は代表+連関の両経路", async () => {
    const res = await GET(getRequest("?q=山田"));
    expect(res.status).toBe(200);
    const where = pm.propertyDmLog.findMany.mock.calls[0][0].where;
    expect(where.propertyId).toBeNull();
    expect(where.OR).toEqual([
      { owner: { name: { contains: "山田" } } },
      { logOwners: { some: { owner: { name: { contains: "山田" } } } } },
    ]);
  });

  it("監査 property_dm_log_view に orphan:true(名前本文は載せない)", async () => {
    pm.propertyDmLog.findMany.mockResolvedValue([
      {
        ...orphanLog(),
        sentAt: new Date("2026-08-01T00:00:00Z"),
        note: null,
        createdAt: new Date(),
        owner: { id: OWNER_1, name: "山田 太郎" },
        logOwners: [{ owner: { id: OWNER_2, name: "山田 花子" } }],
      },
    ]);
    pm.propertyDmLog.count.mockResolvedValue(1);
    const res = await GET(getRequest());
    expect(res.status).toBe(200);
    const audit = vi.mocked(writeAuditLog).mock.calls.at(-1)?.[0] as {
      action: string;
      detail: Record<string, unknown>;
    };
    expect(audit.action).toBe("property_dm_log_view");
    expect(audit.detail.orphan).toBe(true);
    expect(JSON.stringify(audit.detail)).not.toContain("山田");
  });
});

describe("PATCH /api/admin/orphan-dm-logs/[logId](反響訂正)", () => {
  it("property:write 欠如は 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(
      PERMS_ADMIN.filter((p) => p.resource !== "property") as never,
    );
    const res = await PATCH(patchRequest({ status: "replied" }), idCtx);
    expect(res.status).toBe(403);
    expect(pm.propertyDmLog.update).not.toHaveBeenCalled();
  });

  it("propertyId 付きの行(孤児でない=findFirst 空振り)は 404", async () => {
    pm.propertyDmLog.findFirst.mockResolvedValue(null);
    const res = await PATCH(patchRequest({ status: "replied" }), idCtx);
    expect(res.status).toBe(404);
    expect(pm.propertyDmLog.findFirst.mock.calls[0][0].where).toMatchObject({
      id: LOG_ID,
      propertyId: null,
    });
  });

  it("allowlist 外 status は 422・実在しない日付は 422", async () => {
    const res1 = await PATCH(patchRequest({ status: "bogus" }), idCtx);
    expect(res1.status).toBe(422);
    const res2 = await PATCH(
      patchRequest({ status: "replied", reactedAt: "2026-99-99" }),
      idCtx,
    );
    expect(res2.status).toBe(422);
    expect(pm.propertyDmLog.update).not.toHaveBeenCalled();
  });

  it("terminal(refused)は Owner FOR UPDATE(代表+連関)→更新の順(親行ロックは無し=R47)", async () => {
    const res = await PATCH(patchRequest({ status: "refused" }), idCtx);
    expect(res.status).toBe(200);
    const lockCall = vi.mocked(lockOwnersForUpdate).mock.calls[0];
    expect([...(lockCall[1] as string[])].sort()).toEqual(
      [OWNER_1, OWNER_2].sort(),
    );
    expect(
      vi.mocked(lockOwnersForUpdate).mock.invocationCallOrder[0],
    ).toBeLessThan(pm.propertyDmLog.update.mock.invocationCallOrder[0]);
  });

  it("note 省略は既存メモを保持(マスク表示値の往復で消さない=#366 R2)", async () => {
    pm.propertyDmLog.findFirst.mockResolvedValue(
      orphanLog({ reactionNote: "実メモ(サーバ保存値)" }),
    );
    await PATCH(patchRequest({ status: "replied" }), idCtx);
    const data = pm.propertyDmLog.update.mock.calls[0][0].data;
    expect(data.reactionNote).toBe("実メモ(サーバ保存値)");
  });

  it("ロック後の再読取で所有者集合が変わっていたら 409・書き込まない(名寄せレース=#366 R2)", async () => {
    pm.propertyDmLog.findFirst
      .mockResolvedValueOnce(orphanLog())
      .mockResolvedValueOnce(
        orphanLog({ ownerId: "0a000000-0000-4000-8000-000000000009" }),
      );
    const res = await PATCH(patchRequest({ status: "undeliverable" }), idCtx);
    expect(res.status).toBe(409);
    expect(pm.propertyDmLog.update).not.toHaveBeenCalled();
  });

  it("非 terminal は Owner ロックなし・applyManualReaction の形で update", async () => {
    const res = await PATCH(
      patchRequest({ status: "replied", reactedAt: "2026-08-01", note: "電話" }),
      idCtx,
    );
    expect(res.status).toBe(200);
    expect(lockOwnersForUpdate).not.toHaveBeenCalled();
    const data = pm.propertyDmLog.update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      reactionStatus: "replied",
      reactionNote: "電話",
      reactionSource: "manual",
    });
    expect(data.manualReactionShadow).toBe(Prisma.DbNull);
  });

  it("監査 dm_reaction_update {logId,status,reactedAt,orphan:true}", async () => {
    await PATCH(patchRequest({ status: "refused" }), idCtx);
    const audit = vi.mocked(writeAuditLog).mock.calls.at(-1)?.[0] as {
      action: string;
      detail: Record<string, unknown>;
    };
    expect(audit.action).toBe("dm_reaction_update");
    expect(audit.detail).toEqual({
      logId: LOG_ID,
      status: "refused",
      reactedAt: null,
      orphan: true,
    });
  });
});

describe("DELETE /api/admin/orphan-dm-logs/[logId](取消)", () => {
  it("batchId/sale_dm 由来でも孤児は削除可(409 にしない=他に復元経路が無い)", async () => {
    pm.propertyDmLog.findFirst.mockResolvedValue(
      orphanLog({ method: "sale_dm", batchId: "batch-1" }),
    );
    const res = await DELETE(deleteRequest(), idCtx);
    expect(res.status).toBe(200);
    expect(pm.propertyDmLog.delete).toHaveBeenCalledWith({
      where: { id: LOG_ID },
    });
  });

  it("孤児でない行は 404・削除しない", async () => {
    pm.propertyDmLog.findFirst.mockResolvedValue(null);
    const res = await DELETE(deleteRequest(), idCtx);
    expect(res.status).toBe(404);
    expect(pm.propertyDmLog.delete).not.toHaveBeenCalled();
  });

  it("監査 dm_sent_record_delete {logId,orphan:true}", async () => {
    await DELETE(deleteRequest(), idCtx);
    const audit = vi.mocked(writeAuditLog).mock.calls.at(-1)?.[0] as {
      action: string;
      detail: Record<string, unknown>;
    };
    expect(audit.action).toBe("dm_sent_record_delete");
    expect(audit.detail).toEqual({ logId: LOG_ID, orphan: true });
  });
});

describe("監査キー登録(orphan)", () => {
  it("orphan キーが sanitize で残る(3 action)", () => {
    expect(
      (sanitizeAuditDetail("dm_reaction_update", { logId: "l", orphan: true }) as Record<string, unknown>).orphan,
    ).toBe(true);
    expect(
      (sanitizeAuditDetail("dm_sent_record_delete", { logId: "l", orphan: true }) as Record<string, unknown>).orphan,
    ).toBe(true);
    expect(
      (sanitizeAuditDetail("property_dm_log_view", { count: 1, orphan: true }) as Record<string, unknown>).orphan,
    ).toBe(true);
  });
});

describe("UI配線(source)", () => {
  const read = (p: string) =>
    readFileSync(path.join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

  it("サイドバー(データ品質)に孤児DM記録の導線がある", () => {
    const src = read("src/components/layout/sidebar-model.tsx");
    expect(src).toContain("/admin/orphan-dm-logs");
  });

  it("管理ページが存在し API・反響ラベル・削除確認を配線している", () => {
    const src = read("src/app/(dashboard)/admin/orphan-dm-logs/page.tsx");
    expect(src).toContain("/api/admin/orphan-dm-logs");
    expect(src).toContain("REACTION_LABELS");
    expect(src).toMatch(/confirm/);
  });

  it("所有者名(PII)を表示するため画面保護の対象(#366 R9)", () => {
    const src = read("src/app/(dashboard)/admin/orphan-dm-logs/page.tsx");
    expect(src).toContain("data-pii-protected");
    expect(src).toContain('data-pii-surface="owner"');
  });

  it("編集フォームは編集中だけマウント+メモはマスク値を往復させない(#366 R3)", () => {
    const src = read("src/app/(dashboard)/admin/orphan-dm-logs/page.tsx");
    // 行に state を持たず、編集開始時に最新 log で初期化されるフォーム部品
    expect(src).toContain("OrphanReactionEditor");
    expect(src).not.toMatch(/useState\(log\.reactionNote/);
    // 消すのは明示操作(note: null 送信)
    expect(src).toContain("メモを消す");
    expect(src).toMatch(/\{ note: null \}/);
  });
});
