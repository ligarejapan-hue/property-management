/**
 * D10: 謄本PDF取込(手動・自動取得共通のコア processRegistryPdf)は、編集中の鍔
 * (edit_locks)がある物件/所有者の空欄補完を黙って上書きしない。
 *
 * ⚠**registryStatus の unconfirmed→obtained だけは鍵の間も必ず進める**(@codex R6 P1)。
 *   PDFが添付されるのに未確認のまま残るほうが害が大きいための唯一の例外。
 * ⚠確認(鍵の有無)と書き込みは**同じトランザクション・物件/所有者の行ロックの後**に
 *   行う(TOCTOU を閉じる)。読んだ後に鍵を取られると、守るはずの欄を書いてしまう。
 * ⚠フラグは**実際に埋まるはずだった欄があるときだけ**立てる(@codex R10 P2)。
 *
 * ⚠brief のテスト骨子は `readEditLocks` をモックする形だったが、実装済みの API は
 *   `isResourceEditLocked(db, target): Promise<boolean>` なのでこちらをモックする
 *   (Task 3 実装インターフェースが正)。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    property: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    owner: { findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    propertyOwner: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    importJob: { create: vi.fn(), update: vi.fn() },
    importJobRow: { create: vi.fn() },
    attachment: { create: vi.fn() },
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  db.$queryRaw = vi.fn(async () => [{ id: "p1" }]);
  return { default: db };
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
  return { ApiError: MockApiError };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/change-log", () => ({
  recordChanges: vi.fn(),
  PROPERTY_TRACKED_FIELDS: [
    "realEstateNumber",
    "lotNumber",
    "buildingNumber",
    "registryStatus",
  ],
}));
vi.mock("@/lib/pdf-registry-parser", () => ({ parseRegistryText: vi.fn() }));
// 法人番号の検出は候補ゼロを既定にし、個別テストで上書きする。
vi.mock("@/lib/corporate-number", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    detectCorporateNumberInOwnerLike: vi.fn(() => ({ candidates: [] })),
  };
});
vi.mock("@/lib/storage", () => {
  const upload = vi.fn();
  const del = vi.fn();
  return {
    getStorage: () => ({ upload, delete: del }),
    validateFile: vi.fn(() => null),
    ALLOWED_ATTACHMENT_MIMES: ["application/pdf"],
  };
});
vi.mock("node:crypto", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, randomUUID: vi.fn(() => "00000000-0000-4000-8000-000000000000") };
});
vi.mock("@/lib/property-record-guard", () => ({ lockPropertyRow: vi.fn() }));
vi.mock("@/lib/edit-lock/row-locks", () => ({ lockOwnerRow: vi.fn() }));
vi.mock("@/lib/edit-lock/service", () => ({ isResourceEditLocked: vi.fn() }));

import prisma from "@/lib/prisma";
import { parseRegistryText } from "@/lib/pdf-registry-parser";
import { detectCorporateNumberInOwnerLike } from "@/lib/corporate-number";
import { getStorage } from "@/lib/storage";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { lockOwnerRow } from "@/lib/edit-lock/row-locks";
import { isResourceEditLocked } from "@/lib/edit-lock/service";
import { processRegistryPdf } from "@/lib/registry-pdf/process";

const SESSION_ID = "user-1";
const PROP_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "owner-existing";
const PDF = Buffer.from([1, 2, 3, 4, 5]);

const pm = prisma as unknown as {
  $queryRaw: Mock;
  $transaction: Mock;
  property: { findUnique: Mock; updateMany: Mock };
  owner: { findMany: Mock; create: Mock; updateMany: Mock };
  propertyOwner: { findFirst: Mock; findMany: Mock; create: Mock };
  importJob: { create: Mock; update: Mock };
  importJobRow: { create: Mock };
  attachment: { create: Mock };
};

const session = { id: SESSION_ID, role: "admin", email: "u@test", name: "U" };

const BASE_PROPERTY = {
  id: PROP_ID,
  createdBy: SESSION_ID,
  assignedTo: null,
  address: "東京都千代田区一番町1",
  realEstateNumber: null as string | null,
  lotNumber: null as string | null,
  buildingNumber: null as string | null,
  registryStatus: "unconfirmed" as string | null,
  version: 1,
};

const FILLED_PARSED = {
  realEstateNumber: "0100012345678",
  address: "東京都千代田区一番町1",
  lotNumber: "1番",
  buildingNumber: "2号",
  landCategory: null,
  area: null,
  owners: [] as Array<{ name: string; address: string | null; share: string | null }>,
  warnings: [],
  confidence: 0.9,
};

/** その物件に既に紐づいている、住所なしの所有者(取り直し前の状態)を仕込む。 */
function linkedOwner(overrides: { corporateNumber?: string | null } = {}) {
  pm.propertyOwner.findMany.mockResolvedValue([
    {
      owner: {
        id: OWNER_ID,
        name: "山田太郎",
        address: null,
        isArchived: false,
        corporateNumber: overrides.corporateNumber ?? null,
      },
    },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  pm.property.findUnique.mockResolvedValue({ ...BASE_PROPERTY });
  pm.property.updateMany.mockResolvedValue({ count: 1 });
  pm.importJob.create.mockResolvedValue({ id: "job-1" });
  pm.importJob.update.mockResolvedValue({});
  pm.importJobRow.create.mockResolvedValue({});
  pm.owner.findMany.mockResolvedValue([]);
  pm.owner.create.mockResolvedValue({ id: "owner-new" });
  pm.owner.updateMany.mockResolvedValue({ count: 1 });
  pm.propertyOwner.findMany.mockResolvedValue([]);
  pm.propertyOwner.findFirst.mockResolvedValue(null);
  pm.propertyOwner.create.mockResolvedValue({});
  pm.attachment.create.mockResolvedValue({ id: "att-1" });
  pm.$transaction.mockImplementation((cb: (tx: typeof prisma) => unknown) => cb(prisma));
  (getStorage().upload as Mock).mockResolvedValue({ url: "/uploads/x.pdf", key: "x.pdf" });
  (lockPropertyRow as unknown as Mock).mockResolvedValue(undefined);
  (lockOwnerRow as unknown as Mock).mockResolvedValue(undefined);
  (isResourceEditLocked as unknown as Mock).mockResolvedValue(false);
  (parseRegistryText as Mock).mockReturnValue({ ...FILLED_PARSED, owners: [] });
});

const run = (overrides: { pdfBuffer?: Buffer | null } = {}) =>
  processRegistryPdf({
    session,
    text: "dummy",
    propertyId: PROP_ID,
    fileName: "謄本.pdf",
    edited: undefined,
    pdfBuffer: overrides.pdfBuffer ?? null,
    certificateType: "owner",
  });

describe("物件の空欄補完と編集中の鍵", () => {
  it("鍵が無ければ空欄を埋め、取得状況も一緒に進める", async () => {
    (isResourceEditLocked as unknown as Mock).mockResolvedValue(false);
    const result = (await run()) as Record<string, unknown>;
    expect(pm.property.updateMany).toHaveBeenCalledTimes(1);
    expect(pm.property.updateMany.mock.calls[0][0].data).toMatchObject({
      realEstateNumber: "0100012345678",
      lotNumber: "1番",
      buildingNumber: "2号",
      registryStatus: "obtained",
      version: { increment: 1 },
    });
    expect(result.propertyFillSkippedByEditLock).toBe(false);
  });

  it("鍵があっても、埋める余地が無ければフラグを立てない", async () => {
    // 3項目とも既に値が入っており、取得状況も既に確定済み → 書くことが無い。
    pm.property.findUnique.mockResolvedValue({
      ...BASE_PROPERTY,
      realEstateNumber: "0100099999999",
      lotNumber: "9番",
      buildingNumber: "9号",
      registryStatus: "obtained",
    });
    (isResourceEditLocked as unknown as Mock).mockResolvedValue(true);
    const result = (await run()) as Record<string, unknown>;
    expect(pm.property.updateMany).not.toHaveBeenCalled();
    expect(result.propertyFillSkippedByEditLock).toBe(false);
  });

  it("物件に鍵があれば3項目の補完は見送り、取得状況だけ進める。PDF保存は従来どおり", async () => {
    (isResourceEditLocked as unknown as Mock).mockResolvedValue(true);
    const result = (await run({ pdfBuffer: PDF })) as Record<string, unknown>;
    expect(pm.property.updateMany).toHaveBeenCalledTimes(1);
    const data = pm.property.updateMany.mock.calls[0][0].data;
    expect(data.registryStatus).toBe("obtained");
    expect(data.version).toEqual({ increment: 1 });
    expect(data).not.toHaveProperty("realEstateNumber");
    expect(data).not.toHaveProperty("lotNumber");
    expect(data).not.toHaveProperty("buildingNumber");
    expect(result.propertyFillSkippedByEditLock).toBe(true);
    // ⚠PDFの保存(添付)は鍵の有無に関係なく従来どおり実行される。
    expect(pm.attachment.create).toHaveBeenCalledTimes(1);
    expect(result.attachmentId).toBe("att-1");
  });

  it("確認と書き込みは同じトランザクション・行ロックの後に行われる(TOCTOU 対策)", async () => {
    const order: string[] = [];
    let txClient: unknown;
    pm.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      order.push("tx");
      txClient = {
        property: {
          updateMany: vi.fn(async () => {
            order.push("update");
            return { count: 1 };
          }),
        },
      };
      return fn(txClient);
    });
    (lockPropertyRow as unknown as Mock).mockImplementation(async (tx: unknown) => {
      expect(tx).toBe(txClient);
      order.push("lock");
    });
    (isResourceEditLocked as unknown as Mock).mockImplementation(async (tx: unknown) => {
      expect(tx).toBe(txClient);
      order.push("lockCheck");
      return false;
    });

    await run();

    expect(order).toEqual(["tx", "lock", "lockCheck", "update"]);
    // 書き込みが base client(prisma.property.updateMany)へ漏れていない
    // (= トランザクションの外へ逃げていない)ことを固定する。
    expect(pm.property.updateMany).not.toHaveBeenCalled();
  });
});

describe("所有者の法人番号補完と編集中の鍵", () => {
  it("鍵が無ければ法人番号を埋め、版番号を進める", async () => {
    linkedOwner({ corporateNumber: null });
    (detectCorporateNumberInOwnerLike as unknown as Mock).mockReturnValue({
      candidates: ["4011001059442"],
    });
    (isResourceEditLocked as unknown as Mock).mockResolvedValue(false);
    (parseRegistryText as Mock).mockReturnValue({
      ...FILLED_PARSED,
      owners: [{ name: "山田太郎", address: null, share: null }],
    });
    const result = (await run()) as Record<string, unknown>;
    expect(pm.owner.updateMany).toHaveBeenCalledTimes(1);
    expect(pm.owner.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: OWNER_ID, corporateNumber: null },
      data: { corporateNumber: "4011001059442", version: { increment: 1 } },
    });
    expect(result.ownerCorporateFillSkippedByEditLock).toBe(false);
  });

  it("既に法人番号が入っていれば、鍵があってもフラグを立てず lockCheck も呼ばない", async () => {
    linkedOwner({ corporateNumber: "4011001059442" });
    (detectCorporateNumberInOwnerLike as unknown as Mock).mockReturnValue({
      candidates: ["4011001059442"],
    });
    (isResourceEditLocked as unknown as Mock).mockResolvedValue(true);
    (parseRegistryText as Mock).mockReturnValue({
      ...FILLED_PARSED,
      owners: [{ name: "山田太郎", address: null, share: null }],
    });
    const result = (await run()) as Record<string, unknown>;
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
    expect(isResourceEditLocked).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resourceType: "owner" }),
    );
    expect(result.ownerCorporateFillSkippedByEditLock).toBe(false);
  });

  it("所有者に鍵があれば法人番号を埋めず、フラグを立てる", async () => {
    linkedOwner({ corporateNumber: null });
    (detectCorporateNumberInOwnerLike as unknown as Mock).mockReturnValue({
      candidates: ["4011001059442"],
    });
    (isResourceEditLocked as unknown as Mock).mockImplementation(
      async (_tx: unknown, target: { resourceType: string }) =>
        target.resourceType === "owner",
    );
    (parseRegistryText as Mock).mockReturnValue({
      ...FILLED_PARSED,
      owners: [{ name: "山田太郎", address: null, share: null }],
    });
    const result = (await run()) as Record<string, unknown>;
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
    expect(result.ownerCorporateFillSkippedByEditLock).toBe(true);
  });

  it("所有者の確認・補完も、所有者の行をロックした後の同じトランザクションで行う", async () => {
    linkedOwner({ corporateNumber: null });
    (detectCorporateNumberInOwnerLike as unknown as Mock).mockReturnValue({
      candidates: ["4011001059442"],
    });
    (parseRegistryText as Mock).mockReturnValue({
      ...FILLED_PARSED,
      owners: [{ name: "山田太郎", address: null, share: null }],
    });
    const order: string[] = [];
    let ownerTxClient: unknown;
    let txCallCount = 0;
    pm.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      txCallCount++;
      // 呼び出し順は決まっている: ①物件の空欄補完 tx ②住所なし所有者の再利用照会 tx
      // ③(save のときだけ)所有者の法人番号補完 tx。③だけを識別用の別オブジェクトにする。
      if (txCallCount < 3) {
        order.push(`propOrLookupTx${txCallCount}`);
        return fn(prisma);
      }
      order.push("ownerTx");
      ownerTxClient = {
        owner: {
          updateMany: vi.fn(async () => {
            order.push("ownerUpdate");
            return { count: 1 };
          }),
        },
      };
      return fn(ownerTxClient);
    });
    (lockOwnerRow as unknown as Mock).mockImplementation(async (tx: unknown) => {
      expect(tx).toBe(ownerTxClient);
      order.push("ownerLock");
    });
    (isResourceEditLocked as unknown as Mock).mockImplementation(
      async (tx: unknown, target: { resourceType: string }) => {
        if (target.resourceType === "owner") {
          expect(tx).toBe(ownerTxClient);
          order.push("ownerLockCheck");
        }
        return false;
      },
    );

    await run();

    const ownerOrder = order.filter((s) => s.startsWith("owner"));
    expect(ownerOrder).toEqual(["ownerTx", "ownerLock", "ownerLockCheck", "ownerUpdate"]);
  });
});
