/**
 * 住所のある所有者を**新規作成する**経路が、親の物件行をロックしてから作ること。
 *
 * ⚠なぜ必要か(提出前レビューで発見):
 * 同じ物件に対する「謄本から所有者を反映」が2つのタブ/端末からほぼ同時に走ると、
 * どちらも「候補なし」と判定したまま進み、**同姓同住所の所有者が2件でき、両方が
 * 同じ物件に紐づく**。PropertyOwner の一意制約は (物件, 所有者) なので別idの2件は
 * 止められず、owners には氏名+住所の一意制約も無い。
 *
 * 住所**なし**の所有者は以前からロック済み(process-owner-dedupe.test.ts)。
 * ここで固定するのは**住所あり**の経路。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    property: { findUnique: vi.fn(), update: vi.fn() },
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
vi.mock("@/lib/change-log", () => ({ recordChangeLog: vi.fn() }));
vi.mock("@/lib/pdf-registry-parser", () => ({ parseRegistryText: vi.fn() }));
vi.mock("@/lib/corporate-number", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    detectCorporateNumberInOwnerLike: vi.fn(() => ({ candidates: [] })),
  };
});
vi.mock("@/lib/storage", () => ({
  getStorage: () => ({ upload: vi.fn(), delete: vi.fn() }),
  validateFile: vi.fn(() => null),
  ALLOWED_ATTACHMENT_MIMES: ["application/pdf"],
}));

import prisma from "@/lib/prisma";
import { parseRegistryText } from "@/lib/pdf-registry-parser";
import { processRegistryPdf } from "@/lib/registry-pdf/process";

const SESSION_ID = "user-1";
const PROP_ID = "11111111-1111-4111-8111-111111111111";

const pm = prisma as unknown as {
  $queryRaw: Mock;
  $transaction: Mock;
  property: { findUnique: Mock; update: Mock };
  owner: { findMany: Mock; create: Mock; updateMany: Mock };
  propertyOwner: { findFirst: Mock; findMany: Mock; create: Mock };
  importJob: { create: Mock; update: Mock };
  importJobRow: { create: Mock };
};

const OWNER = {
  name: "山田太郎",
  address: "東京都渋谷区神宮前三丁目12番3号",
  share: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  pm.property.findUnique.mockResolvedValue({
    id: PROP_ID,
    createdBy: SESSION_ID,
    assignedTo: null,
    address: "東京都渋谷区神宮前三丁目12-3",
    realEstateNumber: null,
  });
  pm.property.update.mockResolvedValue({ id: PROP_ID });
  pm.importJob.create.mockResolvedValue({ id: "job-1" });
  pm.importJob.update.mockResolvedValue({});
  pm.importJobRow.create.mockResolvedValue({});
  pm.owner.findMany.mockResolvedValue([]);
  pm.owner.create.mockResolvedValue({ id: "owner-new" });
  pm.owner.updateMany.mockResolvedValue({ count: 1 });
  pm.propertyOwner.findMany.mockResolvedValue([]);
  pm.propertyOwner.findFirst.mockResolvedValue(null);
  pm.propertyOwner.create.mockResolvedValue({});
  pm.$transaction.mockImplementation((cb: (tx: typeof prisma) => unknown) =>
    cb(prisma),
  );
  (parseRegistryText as Mock).mockReturnValue({
    realEstateNumber: null,
    address: "東京都渋谷区神宮前三丁目12-3",
    lotNumber: null,
    buildingNumber: null,
    landCategory: null,
    area: null,
    owners: [OWNER],
    warnings: [],
    confidence: 0.9,
  });
});

const run = () =>
  processRegistryPdf({
    session: { id: SESSION_ID, role: "admin" },
    text: "dummy",
    propertyId: PROP_ID,
    fileName: "謄本(所有者事項).pdf",
    edited: undefined,
    pdfBuffer: null,
    certificateType: "owner",
  });

describe("住所ありの所有者を新規作成するとき", () => {
  it("⚠物件行をロックしてから作る（素の create にしない）", async () => {
    await run();

    expect(pm.owner.create).toHaveBeenCalledTimes(1);
    const lockOrder = pm.$queryRaw.mock.invocationCallOrder[0];
    const createOrder = pm.owner.create.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(createOrder);
  });

  it("⚠ロックを取ったあとに、もう一度同じ人がいないか確かめる", async () => {
    await run();
    // 1回目 = ロック前の候補検索 / 2回目 = ロック後の再確認
    expect(pm.owner.findMany.mock.calls.length).toBeGreaterThanOrEqual(2);
    const secondSearch = pm.owner.findMany.mock.invocationCallOrder[1];
    const createOrder = pm.owner.create.mock.invocationCallOrder[0];
    expect(secondSearch).toBeLessThan(createOrder);
  });

  it("⚠同時に走ったもう一方が先に作っていたら、新しく作らずそれを使う", async () => {
    // ロック前は「候補なし」、ロック後の再確認では相手が作った所有者が見える
    pm.owner.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "owner-raced", name: OWNER.name, address: OWNER.address },
      ]);

    await run();

    expect(pm.owner.create).not.toHaveBeenCalled();
    const link = pm.propertyOwner.create.mock.calls[0]?.[0] as
      | { data: { ownerId: string } }
      | undefined;
    expect(link?.data.ownerId).toBe("owner-raced");
  });
});
