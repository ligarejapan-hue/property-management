/**
 * POST /api/admin/owners/correction/merge route tests.
 *
 * Phase 2-B-β: 重複Owner 統合 execute（dryRun=true / dryRun=false）。
 *
 * - 権限: dryRun=true でも owner:delete 必須
 * - tx 内で master/source lock → safety re-check → PropertyOwner 移行 →
 *   OwnerMemo 移行 → source archive → master version bump → ChangeLog
 * - レスポンス / AuditLog detail に PII を含めない
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
    getApiSession: vi.fn().mockResolvedValue({
      id: "user-1",
      email: "admin@test.com",
      name: "Admin",
      role: "admin",
    }),
    getUserPermissions: vi.fn(),
    // 法人番号の経路は owner_corporate_number=full の人だけ（一覧の法人番号一致と同じ）。
    getOwnerDisplayConfig: vi.fn(async () => ({ corporateNumber: "full" })),
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

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

vi.mock("@/lib/prisma", () => {
  const tx = {
    owner: { updateMany: vi.fn(), findUnique: vi.fn() },
    ownerMemo: { updateMany: vi.fn(), count: vi.fn() },
    propertyOwner: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    // 登記上の記載(所有者事項の行)。重複するつながりを消す前に master 側へ引き継ぐ(#714)。
    propertyOwnerRegistryEntry: { findMany: vi.fn(async () => []), update: vi.fn(async () => ({})) },
    // 履歴は「件数」だけでなく「項目名」も見る（現住所だけの編集は統合を許すため）。
    changeLog: { count: vi.fn(), findMany: vi.fn(), createMany: vi.fn() },
    // PR-A(送付記録): DM 参照の付け替え(反響の置き去り防止・@codex R11/R32)。
    propertyDmLog: { updateMany: vi.fn(async () => ({ count: 0 })) },
    dmExportBatchItem: { updateMany: vi.fn(async () => ({ count: 0 })) },
    dmRecipientDraft: { updateMany: vi.fn(async () => ({ count: 0 })) },
    dmExportBatchItemOwner: { updateMany: vi.fn(async () => ({ count: 0 })) },
    propertyDmLogOwner: { updateMany: vi.fn(async () => ({ count: 0 })) },
    dmRecipientDraftOwner: { updateMany: vi.fn(async () => ({ count: 0 })) },
    $executeRaw: vi.fn(async () => 0),
    // Task 8: deleteEditLocksFor は下で `@/lib/edit-lock/service` ごとモックしている
    // ため、この tx は $queryRaw を経由しない(review round2 Minor 5: 以前ここに
    // あった $queryRaw のダミーは死んだ配線だったので削除した)。
  };
  return {
    default: {
      owner: { findUnique: vi.fn() },
      ownerMemo: { count: vi.fn() },
      changeLog: { count: vi.fn(), findMany: vi.fn() },
      importJobRow: { findMany: vi.fn() },
      propertyOwner: { findMany: vi.fn() },
      $transaction: vi
        .fn()
        .mockImplementation((fn: (tx: unknown) => unknown) => fn(tx)),
      _tx: tx,
    },
  };
});

// review round2 item 6: merge の deleteEditLocksFor(source の鍵の後始末)の置き場所は
// これまで走査だけで守られていた。archive/rollback/property-DELETE と同じ技法
// (関数を直接モックし、順序とtxの同一性をピン留めする)をここにも適用する。
vi.mock("@/lib/edit-lock/service", () => ({ deleteEditLocksFor: vi.fn() }));

import prisma from "@/lib/prisma";
import { getUserPermissions } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { deleteEditLocksFor } from "@/lib/edit-lock/service";
import { POST } from "../../app/api/admin/owners/correction/merge/route";

const MASTER_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_ID = "22222222-2222-4222-8222-222222222222";
const MASTER_NAME = "田中太郎";
const MASTER_ADDRESS = "東京都港区1-1";
const SOURCE_NAME = "田中 太郎";
const SOURCE_ADDRESS = "東京都港区1-1";

const FULL_PERMS = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "owner", action: "delete", granted: true },
];

const PERMS_NO_DELETE = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
];

const pm = prisma as unknown as {
  owner: { findUnique: Mock };
  ownerMemo: { count: Mock };
  changeLog: { count: Mock; findMany: Mock };
  importJobRow: { findMany: Mock };
  propertyOwner: { findMany: Mock };
  $transaction: Mock;
  _tx: {
    owner: { updateMany: Mock; findUnique: Mock };
    ownerMemo: { updateMany: Mock; count: Mock };
    propertyOwner: {
      findMany: Mock;
      updateMany: Mock;
      deleteMany: Mock;
    };
    propertyOwnerRegistryEntry: { findMany: Mock; update: Mock };
    changeLog: { count: Mock; findMany: Mock; createMany: Mock };
  };
};

function makeOwner(
  overrides: Partial<{
    id: string;
    name: string;
    address: string | null;
    zip: string | null;
    phone: string | null;
    version: number;
    isArchived: boolean;
    note: string | null;
    externalLinkKey: string | null;
  }> = {},
) {
  return {
    id: overrides.id ?? SOURCE_ID,
    name: overrides.name ?? SOURCE_NAME,
    address:
      overrides.address !== undefined ? overrides.address : SOURCE_ADDRESS,
    zip: overrides.zip !== undefined ? overrides.zip : null,
    phone: overrides.phone !== undefined ? overrides.phone : null,
    version: overrides.version ?? 1,
    isArchived: overrides.isArchived ?? false,
    note: overrides.note ?? null,
    externalLinkKey: overrides.externalLinkKey ?? null,
  };
}

function makeRequest(body: unknown) {
  return new Request(
    "http://localhost/api/admin/owners/correction/merge",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  ) as unknown as import("next/server").NextRequest;
}

function setupEligiblePair() {
  const master = makeOwner({
    id: MASTER_ID,
    name: MASTER_NAME,
    address: MASTER_ADDRESS,
  });
  const source = makeOwner({
    id: SOURCE_ID,
    name: SOURCE_NAME,
    address: SOURCE_ADDRESS,
  });

  pm.owner.findUnique.mockImplementation(
    ({ where }: { where: { id: string } }) => {
      if (where.id === MASTER_ID) return Promise.resolve(master);
      if (where.id === SOURCE_ID) return Promise.resolve(source);
      return Promise.resolve(null);
    },
  );
  pm.changeLog.count.mockResolvedValue(0);
  pm.changeLog.findMany.mockResolvedValue([]);
  pm.importJobRow.findMany.mockResolvedValue([]);
  pm.ownerMemo.count.mockResolvedValue(0);
  pm.propertyOwner.findMany.mockResolvedValue([]);

  // tx mocks
  pm._tx.owner.updateMany.mockResolvedValue({ count: 1 });
  pm._tx.owner.findUnique.mockImplementation(
    ({ where }: { where: { id: string } }) => {
      if (where.id === MASTER_ID) return Promise.resolve(master);
      if (where.id === SOURCE_ID) return Promise.resolve(source);
      return Promise.resolve(null);
    },
  );
  pm._tx.changeLog.count.mockResolvedValue(0);
  pm._tx.changeLog.findMany.mockResolvedValue([]);
  pm._tx.ownerMemo.count.mockResolvedValue(0);
  pm._tx.ownerMemo.updateMany.mockResolvedValue({ count: 0 });
  pm._tx.propertyOwner.findMany.mockResolvedValue([]);
  pm._tx.propertyOwner.deleteMany.mockResolvedValue({ count: 0 });
  pm._tx.propertyOwner.updateMany.mockResolvedValue({ count: 0 });
  pm._tx.changeLog.createMany.mockResolvedValue({ count: 0 });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getUserPermissions).mockResolvedValue(FULL_PERMS);
  pm.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(pm._tx),
  );
});

// ── 権限 / 入力 ────────────────────────────────────────────────────────────

describe("POST merge: 権限・入力検証", () => {
  it("owner:delete なし → dryRun=true でも 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_NO_DELETE);
    setupEligiblePair();
    const res = await POST(
      makeRequest({
        masterId: MASTER_ID,
        sourceId: SOURCE_ID,
        masterVersion: 1,
        sourceVersion: 1,
        dryRun: true,
      }),
    );
    expect(res.status).toBe(403);
  });

  it("owner:delete なし → dryRun=false でも 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_NO_DELETE);
    setupEligiblePair();
    const res = await POST(
      makeRequest({
        masterId: MASTER_ID,
        sourceId: SOURCE_ID,
        masterVersion: 1,
        sourceVersion: 1,
        dryRun: false,
      }),
    );
    expect(res.status).toBe(403);
  });

  it("UUID 不正 → 400", async () => {
    const res = await POST(
      makeRequest({
        masterId: "not-a-uuid",
        sourceId: SOURCE_ID,
        masterVersion: 1,
        sourceVersion: 1,
      }),
    );
    expect(res.status).toBe(400);
  });

  it("version 不正（負数）→ 400", async () => {
    const res = await POST(
      makeRequest({
        masterId: MASTER_ID,
        sourceId: SOURCE_ID,
        masterVersion: 0,
        sourceVersion: 1,
      }),
    );
    expect(res.status).toBe(400);
  });

  it("same_owner_id → 422", async () => {
    const res = await POST(
      makeRequest({
        masterId: MASTER_ID,
        sourceId: MASTER_ID,
        masterVersion: 1,
        sourceVersion: 1,
      }),
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.blockReasons).toContain("same_owner_id");
  });

  it("master/source 両方不存在 → 404", async () => {
    pm.owner.findUnique.mockResolvedValue(null);
    const res = await POST(
      makeRequest({
        masterId: MASTER_ID,
        sourceId: SOURCE_ID,
        masterVersion: 1,
        sourceVersion: 1,
      }),
    );
    expect(res.status).toBe(404);
  });
});

// ── dryRun=true ───────────────────────────────────────────────────────────

describe("POST merge: dryRun=true", () => {
  it("eligible なペア → 200 / executed=false / summary 返却 / DB 更新なし / AuditLog なし", async () => {
    setupEligiblePair();
    const res = await POST(
      makeRequest({
        masterId: MASTER_ID,
        sourceId: SOURCE_ID,
        masterVersion: 1,
        sourceVersion: 1,
        dryRun: true,
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.executed).toBe(false);
    expect(json.eligible).toBe(true);
    expect(json.blockReasons).toEqual([]);
    expect(json.summary).toBeDefined();
    expect(pm.$transaction).not.toHaveBeenCalled();
    expect(pm._tx.ownerMemo.updateMany).not.toHaveBeenCalled();
    expect(pm._tx.propertyOwner.updateMany).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("dryRun デフォルトは true（dryRun キー未指定）", async () => {
    setupEligiblePair();
    const res = await POST(
      makeRequest({
        masterId: MASTER_ID,
        sourceId: SOURCE_ID,
        masterVersion: 1,
        sourceVersion: 1,
      }),
    );
    const json = await res.json();
    expect(json.executed).toBe(false);
  });

  it("source archived → blockReasons=['source_archived']", async () => {
    setupEligiblePair();
    pm.owner.findUnique.mockImplementation(
      ({ where }: { where: { id: string } }) => {
        if (where.id === MASTER_ID)
          return Promise.resolve(
            makeOwner({
              id: MASTER_ID,
              name: MASTER_NAME,
              address: MASTER_ADDRESS,
            }),
          );
        return Promise.resolve(
          makeOwner({
            id: SOURCE_ID,
            name: SOURCE_NAME,
            address: SOURCE_ADDRESS,
            isArchived: true,
          }),
        );
      },
    );
    const res = await POST(
      makeRequest({
        masterId: MASTER_ID,
        sourceId: SOURCE_ID,
        masterVersion: 1,
        sourceVersion: 1,
        dryRun: true,
      }),
    );
    const json = await res.json();
    expect(json.eligible).toBe(false);
    expect(json.blockReasons).toContain("source_archived");
  });

  it("source has ChangeLog → blocked", async () => {
    setupEligiblePair();
    pm.changeLog.count.mockResolvedValue(3);
    // 現住所以外の項目が編集されている＝従来どおり拒否。
    const rows3 = [{ fieldName: "phone" }, { fieldName: "name" }, { fieldName: "note" }];
    pm.changeLog.findMany.mockResolvedValue(rows3);
    pm._tx.changeLog.findMany.mockResolvedValue(rows3);
    const res = await POST(
      makeRequest({
        masterId: MASTER_ID,
        sourceId: SOURCE_ID,
        masterVersion: 1,
        sourceVersion: 1,
        dryRun: true,
      }),
    );
    const json = await res.json();
    expect(json.blockReasons).toContain("source_has_changelog");
  });

  it("source version > 1 → blocked", async () => {
    setupEligiblePair();
    pm.owner.findUnique.mockImplementation(
      ({ where }: { where: { id: string } }) => {
        if (where.id === MASTER_ID)
          return Promise.resolve(
            makeOwner({
              id: MASTER_ID,
              name: MASTER_NAME,
              address: MASTER_ADDRESS,
            }),
          );
        return Promise.resolve(
          makeOwner({
            id: SOURCE_ID,
            name: SOURCE_NAME,
            address: SOURCE_ADDRESS,
            version: 3,
          }),
        );
      },
    );
    const res = await POST(
      makeRequest({
        masterId: MASTER_ID,
        sourceId: SOURCE_ID,
        masterVersion: 1,
        sourceVersion: 3,
        dryRun: true,
      }),
    );
    const json = await res.json();
    expect(json.blockReasons).toContain("source_version_gt_1");
  });

  it("normalize key mismatch → blocked", async () => {
    setupEligiblePair();
    pm.owner.findUnique.mockImplementation(
      ({ where }: { where: { id: string } }) => {
        if (where.id === MASTER_ID)
          return Promise.resolve(
            makeOwner({
              id: MASTER_ID,
              name: "田中太郎",
              address: "東京都港区1-1",
            }),
          );
        return Promise.resolve(
          makeOwner({
            id: SOURCE_ID,
            name: "鈴木次郎",
            address: "大阪府大阪市2-2",
          }),
        );
      },
    );
    const res = await POST(
      makeRequest({
        masterId: MASTER_ID,
        sourceId: SOURCE_ID,
        masterVersion: 1,
        sourceVersion: 1,
        dryRun: true,
      }),
    );
    const json = await res.json();
    expect(json.blockReasons).toContain("owner_identity_mismatch");
  });
});

// ── dryRun=false 成功 ─────────────────────────────────────────────────────

describe("POST merge: dryRun=false 成功", () => {
  it("PropertyOwner 移行 + 重複削除 + OwnerMemo 移行 + source archive + master version bump", async () => {
    setupEligiblePair();
    // master の PropertyOwner: prop-A, prop-B
    // source の PropertyOwner: prop-B (重複), prop-C, prop-D
    const masterPOs = [{ propertyId: "prop-A" }, { propertyId: "prop-B" }];
    const sourcePOs = [
      { propertyId: "prop-B" },
      { propertyId: "prop-C" },
      { propertyId: "prop-D" },
    ];
    pm.propertyOwner.findMany.mockImplementation(
      ({ where }: { where: { ownerId: string } }) => {
        if (where.ownerId === MASTER_ID) return Promise.resolve(masterPOs);
        if (where.ownerId === SOURCE_ID) return Promise.resolve(sourcePOs);
        return Promise.resolve([]);
      },
    );
    // tx 内 propertyOwner.findMany: 1 回目は重複削除 target、2 回目は移動 target
    pm._tx.propertyOwner.findMany
      .mockResolvedValueOnce([{ propertyId: "prop-A" }, { propertyId: "prop-B" }]) // freshMasterPOs (or freshSourcePOs depending on order)
      .mockResolvedValueOnce([
        { propertyId: "prop-B" },
        { propertyId: "prop-C" },
        { propertyId: "prop-D" },
      ]) // freshSourcePOs/Master
      .mockResolvedValueOnce([{ id: "po-dup-1", propertyId: "prop-B" }]) // dedupeTargets
      .mockResolvedValueOnce([{ id: "po-master-B", propertyId: "prop-B" }]) // master 側のつながり(行の引き継ぎ先)
      .mockResolvedValueOnce([{ id: "po-move-1" }, { id: "po-move-2" }]); // moveTargets
    // 消える側(po-dup-1)にだけ登記上の記載が2行ある。master 側(po-master-B)には1行ある。
    pm._tx.propertyOwnerRegistryEntry.findMany.mockImplementation(
      async ({ where }: { where: { propertyOwnerId: string } }) =>
        where.propertyOwnerId === "po-dup-1"
          ? [
              { id: "entry-1", position: 1 },
              { id: "entry-2", position: 2 },
            ]
          : [{ id: "entry-m", position: 1 }],
    );

    pm._tx.ownerMemo.updateMany.mockResolvedValue({ count: 2 });

    const res = await POST(
      makeRequest({
        masterId: MASTER_ID,
        sourceId: SOURCE_ID,
        masterVersion: 1,
        sourceVersion: 1,
        dryRun: false,
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.executed).toBe(true);
    expect(json.result.ownerMemosMoved).toBe(2);
    expect(json.result.propertyOwnersDeduplicated).toBe(1);
    expect(json.result.propertyOwnersMoved).toBe(2);
    expect(json.result.sourceArchived).toBe(true);
    // ⚠重複するつながりを消す**前に**、その登記上の記載を master 側のつながりの後ろへ引き継ぐ
    //   (消すと FK の cascade で内訳ごと無くなる・@codex #714 P2)。
    expect(pm._tx.propertyOwnerRegistryEntry.update.mock.calls.map((c) => c[0])).toEqual([
      { where: { id: "entry-1" }, data: { propertyOwnerId: "po-master-B", position: 2 } },
      { where: { id: "entry-2" }, data: { propertyOwnerId: "po-master-B", position: 3 } },
    ]);
    expect(pm._tx.propertyOwnerRegistryEntry.update.mock.invocationCallOrder[0]).toBeLessThan(
      pm._tx.propertyOwner.deleteMany.mock.invocationCallOrder[0],
    );
    expect(json.masterVersion).toBe(2);
    expect(json.sourceVersion).toBe(2);

    // OwnerMemo 移行クエリ
    expect(pm._tx.ownerMemo.updateMany).toHaveBeenCalledWith({
      where: { ownerId: SOURCE_ID },
      data: { ownerId: MASTER_ID },
    });
    // PropertyOwner 重複削除
    expect(pm._tx.propertyOwner.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["po-dup-1"] } },
    });
    // PropertyOwner 残りを master に付け替え
    expect(pm._tx.propertyOwner.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["po-move-1", "po-move-2"] } },
      data: { ownerId: MASTER_ID },
    });
    // source archive
    expect(pm._tx.owner.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: SOURCE_ID,
          version: 1,
          isArchived: false,
          propertyOwners: { none: {} },
          memos: { none: {} },
        }),
        data: { isArchived: true, version: { increment: 1 } },
      }),
    );
    // master version bump
    expect(pm._tx.owner.updateMany).toHaveBeenCalledWith({
      where: { id: MASTER_ID, version: 1, isArchived: false },
      data: { version: { increment: 1 } },
    });
    // AuditLog
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "owner_correction_merge",
        targetTable: "owners",
        targetId: MASTER_ID,
        detail: expect.objectContaining({
          correctionType: "merge",
          dryRun: false,
          sourceOwnerId: SOURCE_ID,
          propertyOwnersMoved: 2,
          propertyOwnersDeduplicated: 1,
          ownerMemosMoved: 2,
          sourceArchived: true,
        }),
      }),
    );
  });

  // review round2 item 6: master/source の行ロック(owner.updateMany touch)→
  // deleteEditLocksFor(source の鍵の後始末)→ source archive の順で、かつ全て
  // 同じ tx に対して呼ばれることを固定する。cleanup を lock の前や archive の後へ
  // 動かしても、走査(`await deleteEditLocksFor(` の有無)だけでは緑のまま通って
  // しまう(これが Task 8 の核心的な穴)。
  it("Task 8: 行ロック(master→source)→ deleteEditLocksFor(sourceの後始末)→ source archive の順で、同じ tx を使う", async () => {
    setupEligiblePair();
    const order: string[] = [];
    let cleanupTxArg: unknown;

    function labelOf(args: { where: { id: string }; data: Record<string, unknown> }): string {
      if (Object.prototype.hasOwnProperty.call(args.data, "updatedAt")) {
        return args.where.id === MASTER_ID ? "lock-master" : "lock-source";
      }
      if (args.data.isArchived === true) return "archive-source";
      return "master-bump";
    }

    pm._tx.owner.updateMany.mockImplementation(
      async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        order.push(labelOf(args));
        return { count: 1 };
      },
    );
    (deleteEditLocksFor as unknown as Mock).mockImplementation(async (tx: unknown) => {
      order.push("cleanup");
      cleanupTxArg = tx;
      return 0;
    });

    const res = await POST(
      makeRequest({
        masterId: MASTER_ID,
        sourceId: SOURCE_ID,
        masterVersion: 1,
        sourceVersion: 1,
        dryRun: false,
      }),
    );

    expect(res.status).toBe(200);
    expect(order).toEqual(["lock-master", "lock-source", "cleanup", "archive-source", "master-bump"]);
    // ⚠tx そのもの(identity)に対して呼ばれたことを固定する(base client=prisma の
    //   トップレベルではないこと)。
    expect(cleanupTxArg).toBe(pm._tx);
    expect(deleteEditLocksFor).toHaveBeenCalledWith(pm._tx, [
      { resourceType: "owner", resourceId: SOURCE_ID },
    ]);
  });

  it("ChangeLog が PII なしで記録される", async () => {
    setupEligiblePair();
    pm._tx.propertyOwner.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    pm._tx.ownerMemo.updateMany.mockResolvedValue({ count: 0 });

    await POST(
      makeRequest({
        masterId: MASTER_ID,
        sourceId: SOURCE_ID,
        masterVersion: 1,
        sourceVersion: 1,
        dryRun: false,
      }),
    );

    const createCall = pm._tx.changeLog.createMany.mock.calls[0]?.[0];
    expect(createCall).toBeDefined();
    const entries = createCall.data as Array<{
      targetTable: string;
      fieldName: string;
      oldValue: string | null;
      newValue: string | null;
    }>;
    // source の isArchived false→true
    expect(entries).toContainEqual(
      expect.objectContaining({
        targetTable: "owners",
        targetId: SOURCE_ID,
        fieldName: "isArchived",
        oldValue: "false",
        newValue: "true",
      }),
    );
    // master への合成 _merged_from
    expect(entries).toContainEqual(
      expect.objectContaining({
        targetTable: "owners",
        targetId: MASTER_ID,
        fieldName: "_merged_from",
        newValue: SOURCE_ID,
      }),
    );
    // PII を含まないことの assertion
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(MASTER_NAME);
    expect(serialized).not.toContain(MASTER_ADDRESS);
    expect(serialized).not.toContain(SOURCE_NAME);
    expect(serialized).not.toContain(SOURCE_ADDRESS);
  });

  it("API レスポンスに PII（owner 名 / 住所）が含まれない", async () => {
    setupEligiblePair();
    pm._tx.propertyOwner.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    pm._tx.ownerMemo.updateMany.mockResolvedValue({ count: 0 });

    const res = await POST(
      makeRequest({
        masterId: MASTER_ID,
        sourceId: SOURCE_ID,
        masterVersion: 1,
        sourceVersion: 1,
        dryRun: false,
      }),
    );
    const text = await res.text();
    expect(text).not.toContain(MASTER_NAME);
    expect(text).not.toContain(MASTER_ADDRESS);
    expect(text).not.toContain(SOURCE_NAME);
    expect(text).not.toContain(SOURCE_ADDRESS);
  });

  it("AuditLog detail に PII が含まれない", async () => {
    setupEligiblePair();
    pm._tx.propertyOwner.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    pm._tx.ownerMemo.updateMany.mockResolvedValue({ count: 0 });

    await POST(
      makeRequest({
        masterId: MASTER_ID,
        sourceId: SOURCE_ID,
        masterVersion: 1,
        sourceVersion: 1,
        dryRun: false,
      }),
    );
    const call = vi.mocked(writeAuditLog).mock.calls[0][0];
    const serialized = JSON.stringify(call.detail);
    expect(serialized).not.toContain(MASTER_NAME);
    expect(serialized).not.toContain(MASTER_ADDRESS);
    expect(serialized).not.toContain(SOURCE_NAME);
    expect(serialized).not.toContain(SOURCE_ADDRESS);
  });
});

// ── dryRun=false 失敗系 ───────────────────────────────────────────────────

describe("POST merge: dryRun=false 失敗系", () => {
  it("version mismatch（事前判定） → 409", async () => {
    setupEligiblePair();
    const res = await POST(
      makeRequest({
        masterId: MASTER_ID,
        sourceId: SOURCE_ID,
        masterVersion: 999, // DB は 1
        sourceVersion: 1,
        dryRun: false,
      }),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.blockReasons).toContain("version_mismatch");
    expect(pm._tx.ownerMemo.updateMany).not.toHaveBeenCalled();
  });

  it("blocked safety violation → 422", async () => {
    setupEligiblePair();
    pm.changeLog.count.mockResolvedValue(2);
    const rows2 = [{ fieldName: "phone" }, { fieldName: "name" }];
    pm.changeLog.findMany.mockResolvedValue(rows2);
    pm._tx.changeLog.findMany.mockResolvedValue(rows2);
    const res = await POST(
      makeRequest({
        masterId: MASTER_ID,
        sourceId: SOURCE_ID,
        masterVersion: 1,
        sourceVersion: 1,
        dryRun: false,
      }),
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.blockReasons).toContain("source_has_changelog");
    expect(pm._tx.ownerMemo.updateMany).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("tx 内 lock count=0（並行 archive） → 404", async () => {
    setupEligiblePair();
    pm._tx.owner.updateMany.mockResolvedValue({ count: 0 });
    const res = await POST(
      makeRequest({
        masterId: MASTER_ID,
        sourceId: SOURCE_ID,
        masterVersion: 1,
        sourceVersion: 1,
        dryRun: false,
      }),
    );
    expect(res.status).toBe(404);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("tx 内 source archive count=0（並行で PO/memo が増えた）→ 409 version_mismatch", async () => {
    setupEligiblePair();
    pm._tx.propertyOwner.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    // lock 成功 → ownerMemo updateMany 成功 → dedupe / move OK だが
    // source archive で count=0
    pm._tx.owner.updateMany
      .mockResolvedValueOnce({ count: 1 }) // master lock
      .mockResolvedValueOnce({ count: 1 }) // source lock
      .mockResolvedValueOnce({ count: 0 }); // source archive failure
    pm._tx.ownerMemo.updateMany.mockResolvedValue({ count: 0 });

    const res = await POST(
      makeRequest({
        masterId: MASTER_ID,
        sourceId: SOURCE_ID,
        masterVersion: 1,
        sourceVersion: 1,
        dryRun: false,
      }),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.blockReasons).toContain("version_mismatch");
  });
});

// ── 現住所の引き継ぎ（設計 §7） ─────────────────────────────────────────────

const PERMS_WITH_ADDRESS_WRITE = [
  ...FULL_PERMS,
  { resource: "owner", action: "write", granted: true },
  { resource: "owner_address", action: "edit", granted: true },
  { resource: "owner_zip", action: "edit", granted: true },
];

/** master / source の現住所を差し替えて、統合を実行する。 */
function setupCurrentAddressPair(
  masterCur: { currentAddress: string | null; currentZip: string | null },
  sourceCur: { currentAddress: string | null; currentZip: string | null },
  changeLogFields: string[] = [],
) {
  setupEligiblePair();
  const master = {
    ...makeOwner({ id: MASTER_ID, name: MASTER_NAME, address: MASTER_ADDRESS }),
    ...masterCur,
  };
  const source = {
    ...makeOwner({ id: SOURCE_ID, name: SOURCE_NAME, address: SOURCE_ADDRESS }),
    ...sourceCur,
    version: changeLogFields.length > 0 ? 2 : 1,
  };
  const resolve = ({ where }: { where: { id: string } }) => {
    if (where.id === MASTER_ID) return Promise.resolve(master);
    if (where.id === SOURCE_ID) return Promise.resolve(source);
    return Promise.resolve(null);
  };
  pm.owner.findUnique.mockImplementation(resolve);
  pm._tx.owner.findUnique.mockImplementation(resolve);
  const rows = changeLogFields.map((f) => ({ fieldName: f }));
  pm.changeLog.count.mockResolvedValue(rows.length);
  pm.changeLog.findMany.mockResolvedValue(rows);
  pm._tx.changeLog.findMany.mockResolvedValue(rows);
}

function execMerge(sourceVersion = 1) {
  return POST(
    makeRequest({
      masterId: MASTER_ID,
      sourceId: SOURCE_ID,
      masterVersion: 1,
      sourceVersion,
      dryRun: false,
    }),
  );
}

describe("POST merge: 現住所の引き継ぎ", () => {
  beforeEach(() => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_WITH_ADDRESS_WRITE);
  });

  it("残す側が空なら、消える側の現住所をペアごと引き継ぐ", async () => {
    setupCurrentAddressPair(
      { currentAddress: null, currentZip: null },
      { currentAddress: "渋谷区神宮前1-1-1", currentZip: "150-0001" },
    );
    const res = await execMerge();
    expect(res.status).toBe(200);
    // master の version bump と同じ更新で書かれる
    const bump = pm._tx.owner.updateMany.mock.calls
      .map((c: unknown[]) => c[0] as { data: Record<string, unknown> })
      .find((c) => c.data.currentAddress !== undefined);
    expect(bump?.data.currentAddress).toBe("渋谷区神宮前1-1-1");
    expect(bump?.data.currentZip).toBe("150-0001");
  });

  it("引き継いだ2列が変更履歴に残る（前後が追える）", async () => {
    setupCurrentAddressPair(
      { currentAddress: null, currentZip: null },
      { currentAddress: "渋谷区神宮前1-1-1", currentZip: "150-0001" },
    );
    await execMerge();
    const logs = pm._tx.changeLog.createMany.mock.calls[0][0].data as Array<{
      fieldName: string;
      newValue: string | null;
    }>;
    const fields = logs.map((l) => l.fieldName);
    expect(fields).toContain("currentAddress");
    expect(fields).toContain("currentZip");
  });

  it("同じ宛先で残す側の郵便番号だけ空なら、番号だけ引き継ぐ", async () => {
    setupCurrentAddressPair(
      { currentAddress: "渋谷区神宮前1-1-1", currentZip: null },
      { currentAddress: "渋谷区神宮前1-1-1", currentZip: "150-0001" },
    );
    const res = await execMerge();
    expect(res.status).toBe(200);
    const bump = pm._tx.owner.updateMany.mock.calls
      .map((c: unknown[]) => c[0] as { data: Record<string, unknown> })
      .find((c) => c.data.currentZip !== undefined);
    expect(bump?.data.currentZip).toBe("150-0001");
    expect(bump?.data.currentAddress).toBeUndefined();
  });

  it("⚠現住所が食い違うなら統合を拒否する", async () => {
    setupCurrentAddressPair(
      { currentAddress: "渋谷区神宮前1-1-1", currentZip: null },
      { currentAddress: "横浜市南区井土ケ谷中町69-2", currentZip: null },
    );
    const res = await execMerge();
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.blockReasons).toContain("current_address_conflict");
  });

  it("⚠同じ現住所で郵便番号だけ食い違うなら統合を拒否する", async () => {
    setupCurrentAddressPair(
      { currentAddress: "渋谷区神宮前1-1-1", currentZip: "150-0001" },
      { currentAddress: "渋谷区神宮前1-1-1", currentZip: "231-0842" },
    );
    const res = await execMerge();
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.blockReasons).toContain("current_zip_conflict");
  });

  it("⚠あとから現住所を足しただけの相手は統合できる（門が引き継ぎを殺さない）", async () => {
    setupCurrentAddressPair(
      { currentAddress: null, currentZip: null },
      { currentAddress: "渋谷区神宮前1-1-1", currentZip: "150-0001" },
      ["currentAddress", "currentZip"],
    );
    const res = await execMerge(2);
    expect(res.status).toBe(200);
  });

  it("他の項目も編集されている相手は従来どおり拒否", async () => {
    setupCurrentAddressPair(
      { currentAddress: null, currentZip: null },
      { currentAddress: "渋谷区神宮前1-1-1", currentZip: "150-0001" },
      ["currentAddress", "phone"],
    );
    const res = await execMerge(2);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.blockReasons).toContain("source_has_changelog");
  });

  it("⚠住所の書込権限が無い利用者は 403（現住所を黙って捨てない）", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(FULL_PERMS);
    setupCurrentAddressPair(
      { currentAddress: null, currentZip: null },
      { currentAddress: "渋谷区神宮前1-1-1", currentZip: "150-0001" },
    );
    const res = await execMerge();
    expect(res.status).toBe(403);
    // source は archive されない＝現住所が残る
    expect(pm._tx.owner.updateMany).not.toHaveBeenCalled();
  });

  it("現住所を持たない相手なら、住所の書込権限が無くても従来どおり統合できる", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(FULL_PERMS);
    setupCurrentAddressPair(
      { currentAddress: null, currentZip: null },
      { currentAddress: null, currentZip: null },
    );
    const res = await execMerge();
    expect(res.status).toBe(200);
  });
});

// ── 2026-11-24: 法人のペア（法人番号一致・法人名一致）の統合 ───────────────────

const PERMS_CORP_WRITE = [
  ...FULL_PERMS,
  { resource: "owner", action: "write", granted: true },
  { resource: "owner_address", action: "edit", granted: true },
  { resource: "owner_zip", action: "edit", granted: true },
  { resource: "owner_phone", action: "edit", granted: true },
  { resource: "owner_corporate_number", action: "edit", granted: true },
];

const CORP_MASTER = {
  ...makeOwner({ id: MASTER_ID, name: "株式会社サンプル商事", address: "東京都架空区1-1" }),
  corporateNumber: null as string | null,
  currentAddress: null,
  currentZip: null,
};
const CORP_SOURCE = {
  ...makeOwner({ id: SOURCE_ID, name: "㈱サンプル商事", address: "大阪府架空市2-2", phone: "06-0000-0000" }),
  corporateNumber: null as string | null,
  currentAddress: null,
  currentZip: null,
  version: 3,
};

/** 法人のペアを置く。fresh を渡すと tx 内の読み直しだけ差し替える（再確認のテスト用）。 */
function setupCorpPair(
  master: Record<string, unknown> = {},
  source: Record<string, unknown> = {},
  fresh?: { master?: Record<string, unknown>; source?: Record<string, unknown> },
) {
  setupEligiblePair();
  const m = { ...CORP_MASTER, ...master };
  const s = { ...CORP_SOURCE, ...source };
  pm.owner.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
    Promise.resolve(where.id === MASTER_ID ? m : where.id === SOURCE_ID ? s : null),
  );
  const fm = { ...m, ...(fresh?.master ?? {}) };
  const fsrc = { ...s, ...(fresh?.source ?? {}) };
  pm._tx.owner.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
    Promise.resolve(where.id === MASTER_ID ? fm : where.id === SOURCE_ID ? fsrc : null),
  );
  // source は法人の住所・電話の直しで履歴が付いている
  const rows = [{ fieldName: "phone" }, { fieldName: "address" }];
  pm.changeLog.count.mockResolvedValue(rows.length);
  pm.changeLog.findMany.mockResolvedValue(rows);
  pm._tx.changeLog.findMany.mockResolvedValue(rows);
}

function execCorpMerge() {
  return POST(
    makeRequest({
      masterId: MASTER_ID,
      sourceId: SOURCE_ID,
      masterVersion: 1,
      sourceVersion: 3,
      dryRun: false,
    }),
  );
}

function masterUpdates() {
  return pm._tx.owner.updateMany.mock.calls
    .map((c: unknown[]) => c[0] as { where: { id: string }; data: Record<string, unknown> })
    .filter((c) => c.where.id === MASTER_ID && c.data.version !== undefined);
}

function changeLogEntries() {
  return (pm._tx.changeLog.createMany.mock.calls[0]?.[0]?.data ?? []) as Array<{
    targetId: string;
    fieldName: string;
    oldValue: string | null;
    newValue: string | null;
  }>;
}

describe("POST merge: 法人のペア", () => {
  beforeEach(() => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_CORP_WRITE);
  });

  it("住所違いの同じ法人名・source に履歴と version>1 があっても統合できる（dryRun の summary に経路と項目名）", async () => {
    setupCorpPair();
    const res = await POST(
      makeRequest({
        masterId: MASTER_ID,
        sourceId: SOURCE_ID,
        masterVersion: 1,
        sourceVersion: 3,
        dryRun: true,
      }),
    );
    const json = await res.json();
    expect(json.eligible).toBe(true);
    expect(json.summary.matchedBy).toBe("corporate_name");
    expect(json.summary.corporateHandoverFields).toEqual(["phone"]);
    expect(JSON.stringify(json)).not.toContain("06-0000-0000");
  });

  it("master が空の電話を写し、master の版上げは1回だけ・同じ更新で書く", async () => {
    setupCorpPair();
    const res = await execCorpMerge();
    expect(res.status).toBe(200);
    const updates = masterUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0].data.phone).toBe("06-0000-0000");
    // 住所は master にあるので写さない
    expect(updates[0].data.address).toBeUndefined();
    expect(changeLogEntries()).toContainEqual(
      expect.objectContaining({
        targetId: MASTER_ID,
        fieldName: "phone",
        oldValue: null,
        newValue: "06-0000-0000",
      }),
    );
  });

  it("source の登記上の住所は必ず master の変更履歴に1行残る", async () => {
    setupCorpPair();
    await execCorpMerge();
    const rows = changeLogEntries().filter((e) => e.fieldName === "_merged_source_address");
    expect(rows).toEqual([
      expect.objectContaining({ targetId: MASTER_ID, newValue: "大阪府架空市2-2" }),
    ]);
  });

  it("両方に電話があって違うなら写さず、source の値を記録に残す", async () => {
    setupCorpPair({ phone: "03-1111-1111" });
    const res = await execCorpMerge();
    expect(res.status).toBe(200);
    expect(masterUpdates()[0].data.phone).toBeUndefined();
    expect(changeLogEntries()).toContainEqual(
      expect.objectContaining({
        targetId: MASTER_ID,
        fieldName: "_merged_source_phone",
        newValue: "06-0000-0000",
      }),
    );
  });

  it("master の住所・郵便番号・法人番号が空なら写す（法人番号は13桁にそろえる）", async () => {
    setupCorpPair(
      { address: null, corporateNumber: null },
      { zip: "530-0000", corporateNumber: "1234-5678-90123" },
    );
    const res = await execCorpMerge();
    expect(res.status).toBe(200);
    const data = masterUpdates()[0].data;
    expect(data.address).toBe("大阪府架空市2-2");
    expect(data.zip).toBe("530-0000");
    expect(data.corporateNumber).toBe("1234567890123");
  });

  it("⚠写す項目の編集権限が無ければ 403（黙って捨てない）", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(
      PERMS_CORP_WRITE.filter((p) => p.resource !== "owner_phone"),
    );
    setupCorpPair();
    const res = await execCorpMerge();
    expect(res.status).toBe(403);
    expect(pm._tx.owner.updateMany).not.toHaveBeenCalled();
  });

  it("⚠tx 内で読み直した値で写す項目が増え、その権限が無ければ 403（何も書かない）", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(
      PERMS_CORP_WRITE.filter((p) => p.resource !== "owner_phone"),
    );
    // 事前: master に電話あり（写さない＝電話の権限は要らない）→ tx 内: master の電話が消えていた
    setupCorpPair({ phone: "03-1111-1111" }, {}, { master: { phone: null } });
    const res = await execCorpMerge();
    expect(res.status).toBe(403);
    expect(pm._tx.changeLog.createMany).not.toHaveBeenCalled();
    expect(masterUpdates()).toHaveLength(0);
  });

  it("⚠tx 内で読み直すと別の名前（個人）になっていたら止める（owner_identity_mismatch）", async () => {
    setupCorpPair({}, {}, { source: { name: "架空太郎" } });
    const res = await execCorpMerge();
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.blockReasons).toContain("owner_identity_mismatch");
    expect(pm._tx.changeLog.createMany).not.toHaveBeenCalled();
  });

  it("⚠tx 内で読み直すと法人番号が食い違っていたら止める（corporate_number_conflict）", async () => {
    setupCorpPair(
      { corporateNumber: "1234567890123" },
      {},
      { source: { corporateNumber: "9876543210987" } },
    );
    const res = await execCorpMerge();
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.blockReasons).toContain("corporate_number_conflict");
  });

  it("個人は従来どおり: 住所が違えば止め、同じなら項目の引き継ぎも住所の記録もしない", async () => {
    setupCorpPair({ name: "架空太郎" }, { name: "架空太郎", version: 1 });
    pm.changeLog.count.mockResolvedValue(0);
    pm.changeLog.findMany.mockResolvedValue([]);
    pm._tx.changeLog.findMany.mockResolvedValue([]);
    const blocked = await POST(
      makeRequest({ masterId: MASTER_ID, sourceId: SOURCE_ID, masterVersion: 1, sourceVersion: 1, dryRun: false }),
    );
    expect(blocked.status).toBe(422);
    expect((await blocked.json()).error.blockReasons).toContain("owner_identity_mismatch");

    vi.clearAllMocks();
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_CORP_WRITE);
    pm.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(pm._tx));
    setupCorpPair(
      { name: "架空太郎" },
      { name: "架空太郎", address: "東京都架空区1-1", version: 1 },
    );
    pm.changeLog.count.mockResolvedValue(0);
    pm.changeLog.findMany.mockResolvedValue([]);
    pm._tx.changeLog.findMany.mockResolvedValue([]);
    const ok = await POST(
      makeRequest({ masterId: MASTER_ID, sourceId: SOURCE_ID, masterVersion: 1, sourceVersion: 1, dryRun: false }),
    );
    expect(ok.status).toBe(200);
    expect(masterUpdates()[0].data.phone).toBeUndefined();
    expect(changeLogEntries().map((e) => e.fieldName)).not.toContain("_merged_source_address");
  });

  it("AuditLog detail は経路と項目名だけ（名前・住所・電話を含まない）", async () => {
    setupCorpPair();
    await execCorpMerge();
    const detail = vi.mocked(writeAuditLog).mock.calls[0][0].detail as Record<string, unknown>;
    expect(detail.matchedBy).toBe("corporate_name");
    expect(detail.corporateHandoverFields).toEqual(["phone"]);
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain("サンプル");
    expect(serialized).not.toContain("架空");
    expect(serialized).not.toContain("06-0000-0000");
  });
});

// ── review P2: 法人のペアで メール・会社法人等番号・フリガナ を落とさない ─────────────
describe("POST merge: 法人のペア（メール・会社法人等番号・フリガナ）", () => {
  const PERMS_ALL = [
    ...PERMS_CORP_WRITE,
    { resource: "owner_email", action: "edit", granted: true },
    { resource: "owner_name_kana", action: "edit", granted: true },
  ];
  beforeEach(() => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_ALL);
  });

  it("master が空のメール・会社法人等番号・フリガナを写し、変更履歴に前後を残す", async () => {
    setupCorpPair(
      { phone: "06-0000-0000", email: null, nameKana: null, companyRegistryNumber: null },
      { email: "info@example.invalid", nameKana: "サンプルショウジ", companyRegistryNumber: "0100-01-012345" },
    );
    const res = await execCorpMerge();
    expect(res.status).toBe(200);
    const data = masterUpdates()[0].data;
    expect(data.email).toBe("info@example.invalid");
    expect(data.nameKana).toBe("サンプルショウジ");
    expect(data.companyRegistryNumber).toBe("010001012345");
    const fields = changeLogEntries().map((e) => e.fieldName);
    expect(fields).toEqual(expect.arrayContaining(["email", "nameKana", "companyRegistryNumber"]));
  });

  it("両方にあって違うメールは写さず _merged_source_email に残す", async () => {
    setupCorpPair(
      { phone: "06-0000-0000", email: "a@example.invalid" },
      { email: "b@example.invalid" },
    );
    const res = await execCorpMerge();
    expect(res.status).toBe(200);
    expect(masterUpdates()[0].data.email).toBeUndefined();
    expect(changeLogEntries()).toContainEqual(
      expect.objectContaining({ fieldName: "_merged_source_email", newValue: "b@example.invalid" }),
    );
  });

  it("⚠メールの編集権限が無く、写す必要があれば 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(
      PERMS_ALL.filter((p) => p.resource !== "owner_email"),
    );
    setupCorpPair({ phone: "06-0000-0000", email: null }, { email: "info@example.invalid" });
    const res = await execCorpMerge();
    expect(res.status).toBe(403);
    expect(masterUpdates()).toHaveLength(0);
  });

  it("⚠会社法人等番号が両方にあって違えば止める（tx の前）", async () => {
    setupCorpPair(
      { companyRegistryNumber: "010001012345" },
      { companyRegistryNumber: "020001054321" },
    );
    const res = await execCorpMerge();
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.blockReasons).toContain("company_registry_number_conflict");
  });

  it("⚠tx 内で読み直すと会社法人等番号が食い違っていたら止める", async () => {
    setupCorpPair(
      { companyRegistryNumber: "010001012345" },
      {},
      { source: { companyRegistryNumber: "020001054321" } },
    );
    const res = await execCorpMerge();
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.blockReasons).toContain("company_registry_number_conflict");
    expect(pm._tx.changeLog.createMany).not.toHaveBeenCalled();
  });
});

// ── @codex R2: 形式をまたぐ番号の食い違い・住所と郵便番号の組 ─────────────────────
describe("POST merge: 法人のペア（番号の形式またぎ・住所と郵便番号の組）", () => {
  beforeEach(() => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_CORP_WRITE);
  });

  it("⚠tx 内で読み直すと、相手の12桁が自分の13桁の後ろ12桁と違っていたら止める", async () => {
    // 010001012345 から作った13桁 = 4010001012345
    setupCorpPair(
      { corporateNumber: "4010001012345" },
      {},
      { source: { companyRegistryNumber: "020001054321" } },
    );
    const res = await execCorpMerge();
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.blockReasons).toContain("company_registry_number_conflict");
    expect(pm._tx.changeLog.createMany).not.toHaveBeenCalled();
  });

  it("master の住所が空で郵便番号が違えば、住所と郵便番号を組で上書きし、古い郵便番号を変更履歴に残す", async () => {
    setupCorpPair(
      { address: null, zip: "100-0000", phone: "06-0000-0000" },
      { zip: "530-0000" },
    );
    const res = await execCorpMerge();
    expect(res.status).toBe(200);
    const data = masterUpdates()[0].data;
    expect(data.address).toBe("大阪府架空市2-2");
    expect(data.zip).toBe("530-0000");
    expect(changeLogEntries()).toContainEqual(
      expect.objectContaining({ fieldName: "zip", oldValue: "100-0000", newValue: "530-0000" }),
    );
  });

  it("⚠郵便番号の編集権限が無ければ、住所だけ写すのではなく 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(
      PERMS_CORP_WRITE.filter((p) => p.resource !== "owner_zip"),
    );
    setupCorpPair(
      { address: null, zip: "100-0000", phone: "06-0000-0000" },
      { zip: "530-0000" },
    );
    const res = await execCorpMerge();
    expect(res.status).toBe(403);
    expect(masterUpdates()).toHaveLength(0);
  });
});

// ── @codex R3: 続けて統合しても、前の統合の記録(_merged_source_*)を落とさない ─────────────
describe("POST merge: 前の統合の記録を引き継ぐ", () => {
  beforeEach(() => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_CORP_WRITE);
  });

  it("source に残っている _merged_source_* の行を、元の日時・記録した人のまま master にも写す（source の行は消さない）", async () => {
    setupCorpPair({ phone: "06-0000-0000" });
    const earlier = new Date("2026-11-01T01:02:03Z");
    pm._tx.changeLog.findMany.mockResolvedValue([
      { fieldName: "phone", oldValue: "06-1", newValue: "06-0000-0000", source: "manual", changedBy: "user-9", changedAt: earlier },
      { fieldName: "_merged_source_address", oldValue: null, newValue: "京都府架空市3-3", source: "manual", changedBy: "user-9", changedAt: earlier },
      { fieldName: "_merged_from", oldValue: null, newValue: "33333333-3333-4333-8333-333333333333", source: "manual", changedBy: "user-9", changedAt: earlier },
    ]);
    const res = await execCorpMerge();
    expect(res.status).toBe(200);
    const carried = changeLogEntries().filter(
      (e) => e.targetId === MASTER_ID && e.newValue === "京都府架空市3-3",
    );
    expect(carried).toEqual([
      expect.objectContaining({
        targetTable: "owners",
        fieldName: "_merged_source_address",
        oldValue: null,
        changedBy: "user-9",
        changedAt: earlier,
      }),
    ]);
    // 統合の記録以外（phone の変更・_merged_from）は写さない
    expect(changeLogEntries().filter((e) => e.targetId === MASTER_ID && e.newValue === "06-0000-0000" && e.fieldName === "phone")).toEqual([]);
    // source の行を消す呼び出しは無い
    expect((pm._tx.changeLog as Record<string, unknown>).deleteMany).toBeUndefined();
  });
});
