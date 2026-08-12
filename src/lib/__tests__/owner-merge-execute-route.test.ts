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

import prisma from "@/lib/prisma";
import { getUserPermissions } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
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
    expect(json.blockReasons).toContain("name_address_normalize_mismatch");
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
      .mockResolvedValueOnce([{ id: "po-dup-1" }]) // dedupeTargets
      .mockResolvedValueOnce([{ id: "po-move-1" }, { id: "po-move-2" }]); // moveTargets

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
