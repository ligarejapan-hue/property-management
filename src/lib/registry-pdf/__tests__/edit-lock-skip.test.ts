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
    owner: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
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
  recordChanges: vi.fn().mockResolvedValue(undefined),
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
import { recordChanges } from "@/lib/change-log";
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
  owner: { findUnique: Mock; findMany: Mock; create: Mock; updateMany: Mock };
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

/**
 * その物件に既に紐づいている、住所なしの所有者(取り直し前の状態)を仕込む。
 * ⚠`owner.findUnique`(ロック後の読み直し・レビュー round1 #3)も同じ値で
 * 揃える。取り違えると「決定時点の値」と「ロック後の読み直し値」がずれ、
 * 見送りフラグのテストが検査したい対象と違うものを検査してしまう。
 */
function linkedOwner(overrides: { corporateNumber?: string | null } = {}) {
  const corporateNumber = overrides.corporateNumber ?? null;
  pm.propertyOwner.findMany.mockResolvedValue([
    {
      owner: {
        id: OWNER_ID,
        name: "山田太郎",
        address: null,
        isArchived: false,
        corporateNumber,
      },
    },
  ]);
  pm.owner.findUnique.mockResolvedValue({ corporateNumber });
}

beforeEach(() => {
  vi.clearAllMocks();
  pm.property.findUnique.mockResolvedValue({ ...BASE_PROPERTY });
  pm.property.updateMany.mockResolvedValue({ count: 1 });
  pm.importJob.create.mockResolvedValue({ id: "job-1" });
  pm.importJob.update.mockResolvedValue({});
  pm.importJobRow.create.mockResolvedValue({});
  pm.owner.findMany.mockResolvedValue([]);
  pm.owner.findUnique.mockResolvedValue({ corporateNumber: null });
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
          findUnique: vi.fn(async () => {
            order.push("freshRead");
            return { ...BASE_PROPERTY };
          }),
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

    // ⚠レビュー round1 #2: ロック直後に現在値(version/registryStatus等)を
    //   読み直す(freshRead)ため、lock と lockCheck の間に増えた。
    expect(order).toEqual(["tx", "lock", "freshRead", "lockCheck", "update"]);
    // 書き込みが base client(prisma.property.updateMany)へ漏れていない
    // (= トランザクションの外へ逃げていない)ことを固定する。
    expect(pm.property.updateMany).not.toHaveBeenCalled();
  });

  it("外側で読んだversionが古くても、ロック後に読み直した現在値で書き込む(取得状況は進む)", async () => {
    // レビュー round1 #2: 外側の existing 読み取り後、行ロックを取るまでの間に
    // 別の保存(鍵の持ち主による無関係な更新)で version が進んでいることがある。
    // 古い version のまま where 条件に使うと updateMany が0件になり、
    // 「進めたことになっているのに実際は書けていない」嘘の状態になる。
    const stale = { ...BASE_PROPERTY, version: 1, realEstateNumber: null, lotNumber: null, buildingNumber: null };
    const fresh = { ...BASE_PROPERTY, version: 5, realEstateNumber: null, lotNumber: null, buildingNumber: null };
    pm.property.findUnique
      .mockResolvedValueOnce(stale) // Mode A 入口の existing 読み取り
      .mockResolvedValue(fresh); // tx 内の読み直し(以降は全てこれ)
    (isResourceEditLocked as unknown as Mock).mockResolvedValue(true); // 鍵あり(取得状況だけ進む)

    const result = (await run()) as Record<string, unknown>;

    expect(pm.property.updateMany).toHaveBeenCalledTimes(1);
    const call = pm.property.updateMany.mock.calls[0][0];
    // where.version は読み直した fresh(5) を使う。古い stale(1) ではない。
    expect(call.where).toEqual({ id: PROP_ID, version: 5 });
    expect(call.data).toMatchObject({ registryStatus: "obtained", version: { increment: 1 } });
    expect(result.propertyFillSkippedByEditLock).toBe(true);
    // 実際に書いた内容どおりに記録される。
    expect(recordChanges).toHaveBeenCalledTimes(1);
    expect((recordChanges as Mock).mock.calls[0][0].newValues).toEqual({
      registryStatus: "obtained",
    });
  });

  it("ロック後に読み直してもなお0件更新なら、進めたことにせず記録も残さない", async () => {
    // 上とは別の(さらに稀な)ケース: fresh 基準で組み立てた where でも、
    // updateMany 自体が0件を返した場合。書けていないのに「書いた」と
    // recordChanges に嘘を渡さないことを確認する。
    pm.property.updateMany.mockResolvedValue({ count: 0 });
    (isResourceEditLocked as unknown as Mock).mockResolvedValue(false);

    const result = (await run()) as Record<string, unknown>;

    expect(pm.property.updateMany).toHaveBeenCalledTimes(1);
    expect(recordChanges).not.toHaveBeenCalled();
    expect(result.action).toBe("matched");
    expect(result.propertyFillSkippedByEditLock).toBe(false);
  });

  it("変更履歴の『変更前』も、外側の古い値ではなくロック後に読み直した現在値を使う(round1再点検 M1)", async () => {
    // 外側で読んだ existing は realEstateNumber="OLD-NUM"(埋まっている)だが、
    // 行ロックを取るまでの間に鍵の持ち主がそれを消し(null に戻し)ていた、
    // というシナリオ。もし oldValues に外側の値をそのまま使うと、
    // 「OLD-NUM → 新しい番号」という記録になるが、実際に上書きされた値は
    // null なので嘘になる。fresh(トランザクション内の読み直し)を使えば
    // 「(空) → 新しい番号」という正しい記録になる。
    const stale = {
      ...BASE_PROPERTY,
      version: 1,
      realEstateNumber: "OLD-NUM",
      lotNumber: null,
      buildingNumber: null,
      registryStatus: "unconfirmed",
    };
    const fresh = {
      ...BASE_PROPERTY,
      version: 1,
      realEstateNumber: null, // ロック取得までの間に他の書き込みで消えていた
      lotNumber: null,
      buildingNumber: null,
      registryStatus: "unconfirmed",
    };
    pm.property.findUnique
      .mockResolvedValueOnce(stale) // Mode A 入口の existing 読み取り
      .mockResolvedValue(fresh); // tx 内の読み直し(以降は全てこれ)
    (isResourceEditLocked as unknown as Mock).mockResolvedValue(false); // 鍵なし=補完も進む

    await run();

    expect(recordChanges).toHaveBeenCalledTimes(1);
    const call = (recordChanges as Mock).mock.calls[0][0];
    // 「変更前」は fresh(null) であって、外側の stale("OLD-NUM")ではない。
    expect(call.oldValues.realEstateNumber).toBeNull();
    expect(call.oldValues.realEstateNumber).not.toBe("OLD-NUM");
    expect(call.newValues.realEstateNumber).toBe("0100012345678");
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
          findUnique: vi.fn(async () => {
            order.push("ownerFreshRead");
            return { corporateNumber: null };
          }),
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

    // ⚠レビュー round1 #3: lockOwnerRow の後・isResourceEditLocked の前に
    //   corporateNumber を読み直す(ownerFreshRead)ため、ownerLock と
    //   ownerLockCheck の間に増えた。
    const ownerOrder = order.filter((s) => s.startsWith("owner"));
    expect(ownerOrder).toEqual([
      "ownerTx",
      "ownerLock",
      "ownerFreshRead",
      "ownerLockCheck",
      "ownerUpdate",
    ]);
  });

  it("ロックの後に読み直した法人番号が既に埋まっていれば、鍵の有無に関わらずフラグを立てない", async () => {
    // レビュー round1 #3: decideCorporateImport の判定時点(existingCorporateNumber
    // を読んだ時)から所有者の行をロックするまでの間に、別の書き込みが既に
    // 埋めていることがある。その場合は書く余地が無いので、鍵が有っても
    // 「見送った」フラグを立てない(埋める余地が無ければ見送りにならない)。
    linkedOwner({ corporateNumber: null }); // 判定時点では空(decideCorporateImportが"save"になる)
    (detectCorporateNumberInOwnerLike as unknown as Mock).mockReturnValue({
      candidates: ["4011001059442"],
    });
    // ロック後の読み直しでは、既に別の書き込みで埋まっている。
    pm.owner.findUnique.mockResolvedValue({ corporateNumber: "9999999999999" });
    (isResourceEditLocked as unknown as Mock).mockResolvedValue(true);
    (parseRegistryText as Mock).mockReturnValue({
      ...FILLED_PARSED,
      owners: [{ name: "山田太郎", address: null, share: null }],
    });

    const result = (await run()) as Record<string, unknown>;

    expect(pm.owner.updateMany).not.toHaveBeenCalled();
    expect(result.ownerCorporateFillSkippedByEditLock).toBe(false);
    // 書く余地が無いと分かった時点で返るので、鍵の確認(owner向け)自体を呼ばない。
    expect(isResourceEditLocked).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resourceType: "owner" }),
    );
  });
});

// ⚠レビュー round1 #4: 法人番号の空欄補完はもう1か所ある(住所ありの経路・process.ts:410
//   付近)。上のテスト群はすべて住所なしの経路(:285付近)しか通っておらず、
//   source-scan(owner-corporate-import-integration.test.ts)だけがこちらを見ていた。
//   同じ挙動を実際に走らせて確認する。
describe("所有者の法人番号補完(住所ありの経路)と編集中の鍵", () => {
  const ADDR_OWNER_ID = "owner-addr";

  /** 全体照合(normalizeName+normalizeAddress)にヒットする既存 active owner を仕込む。 */
  function addressedCandidate(corporateNumber: string | null) {
    pm.owner.findMany.mockResolvedValue([
      {
        id: ADDR_OWNER_ID,
        name: "鈴木一郎",
        address: "東京都港区1-1",
        corporateNumber,
      },
    ]);
    pm.owner.findUnique.mockResolvedValue({ corporateNumber });
  }

  beforeEach(() => {
    // 既存 owner の lock+verify(where: {isArchived:false}) と、法人番号の
    // 空欄埋め(where: {corporateNumber:null}) の両方がこの1つの mock を通る。
    // どちらも count:1 で成功させる既定。
    pm.owner.updateMany.mockResolvedValue({ count: 1 });
    pm.propertyOwner.findFirst.mockResolvedValue(null);
    (detectCorporateNumberInOwnerLike as unknown as Mock).mockReturnValue({
      candidates: ["4011001059442"],
    });
    (parseRegistryText as Mock).mockReturnValue({
      ...FILLED_PARSED,
      owners: [{ name: "鈴木一郎", address: "東京都港区1-1", share: null }],
    });
  });

  /** 法人番号の空欄埋め呼び出しだけを owner.updateMany の呼び出し群から拾う。 */
  function findCorporateFillCall() {
    return pm.owner.updateMany.mock.calls.find(
      (c) => c[0]?.where?.corporateNumber === null && c[0]?.data?.corporateNumber,
    );
  }

  it("鍵が無ければ法人番号を埋め、版番号を進める", async () => {
    addressedCandidate(null);
    (isResourceEditLocked as unknown as Mock).mockResolvedValue(false);

    const result = (await run()) as Record<string, unknown>;

    const fillCall = findCorporateFillCall();
    expect(fillCall).toBeTruthy();
    expect(fillCall![0]).toMatchObject({
      where: { id: ADDR_OWNER_ID, corporateNumber: null },
      data: { corporateNumber: "4011001059442", version: { increment: 1 } },
    });
    expect(result.ownerCorporateFillSkippedByEditLock).toBe(false);
  });

  it("所有者に鍵があれば法人番号を埋めず、フラグを立てる", async () => {
    addressedCandidate(null);
    (isResourceEditLocked as unknown as Mock).mockResolvedValue(true);

    const result = (await run()) as Record<string, unknown>;

    expect(findCorporateFillCall()).toBeUndefined();
    expect(result.ownerCorporateFillSkippedByEditLock).toBe(true);
  });
});
