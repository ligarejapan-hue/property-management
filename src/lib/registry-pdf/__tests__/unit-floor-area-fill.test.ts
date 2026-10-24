/**
 * 区分の登記簿の専有面積を謄本から埋める(2026-10-25 発注者「謄本から面積を自動で入れる」)。
 * 謄本PDF取込のコア processRegistryPdf の Mode A(物件を指定した取込・購入後の自動取得)。
 * ⚠区分マンションで欄が空のときだけ埋める(ほかの3項目と同じ「空欄だけ」)・編集中の鍵の間は見送る・
 *   変更履歴の「変更前」はロック後に読み直した値・所有者だけの反映(ownersOnly)では触らない。
 * 設定(モック)は edit-lock-skip.test.ts と同じ。
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
import { getStorage } from "@/lib/storage";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { lockOwnerRow } from "@/lib/edit-lock/row-locks";
import { isResourceEditLocked } from "@/lib/edit-lock/service";
import { processRegistryPdf } from "@/lib/registry-pdf/process";

const SESSION_ID = "user-1";
const PROP_ID = "11111111-1111-4111-8111-111111111111";

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


const UNIT = { ...BASE_PROPERTY, propertyType: "apartment_unit", exclusiveAreaRegistry: null as unknown };

describe("区分の登記簿の専有面積を謄本から埋める", () => {
  beforeEach(() => {
    (parseRegistryText as Mock).mockReturnValue({ ...FILLED_PARSED, owners: [], unitFloorArea: "63.50" });
  });

  it("★区分で欄が空なら、読んだ専有部分の床面積を登記簿の欄に入れる(変更履歴も)", async () => {
    pm.property.findUnique.mockResolvedValue({ ...UNIT });
    await run();
    expect(pm.property.updateMany).toHaveBeenCalledTimes(1);
    expect(pm.property.updateMany.mock.calls[0][0].data).toMatchObject({
      exclusiveAreaRegistry: "63.50",
      version: { increment: 1 },
    });
    const rc = (recordChanges as Mock).mock.calls[0][0];
    expect(rc.newValues).toMatchObject({ exclusiveAreaRegistry: "63.50" });
    // 変更前はロック後に読み直した値(この列も select している)。
    expect(rc.oldValues).toHaveProperty("exclusiveAreaRegistry", null);
    const select = pm.property.findUnique.mock.calls.map((c) => c[0]?.select).find((s) => s?.version);
    expect(select).toMatchObject({ exclusiveAreaRegistry: true, propertyType: true });
  });

  it("★すでに入っている値は上書きしない", async () => {
    pm.property.findUnique.mockResolvedValue({
      ...UNIT,
      realEstateNumber: "0100099999999",
      lotNumber: "9番",
      buildingNumber: "9号",
      registryStatus: "obtained",
      exclusiveAreaRegistry: "60.00",
    });
    await run();
    expect(pm.property.updateMany).not.toHaveBeenCalled();
  });

  it("★区分でない物件(戸建・土地など)には入れない", async () => {
    pm.property.findUnique.mockResolvedValue({ ...UNIT, propertyType: "house" });
    await run();
    expect(pm.property.updateMany.mock.calls[0][0].data).not.toHaveProperty("exclusiveAreaRegistry");
  });

  it("読めなかった(null)ときは入れない", async () => {
    (parseRegistryText as Mock).mockReturnValue({ ...FILLED_PARSED, owners: [], unitFloorArea: null });
    pm.property.findUnique.mockResolvedValue({ ...UNIT });
    await run();
    expect(pm.property.updateMany.mock.calls[0][0].data).not.toHaveProperty("exclusiveAreaRegistry");
  });

  it("★編集中の鍵の間は見送り、見送ったことを返す", async () => {
    pm.property.findUnique.mockResolvedValue({
      ...UNIT,
      realEstateNumber: "0100099999999",
      lotNumber: "9番",
      buildingNumber: "9号",
      registryStatus: "obtained",
    });
    (isResourceEditLocked as unknown as Mock).mockResolvedValue(true);
    const result = (await run()) as Record<string, unknown>;
    expect(pm.property.updateMany).not.toHaveBeenCalled();
    expect(result.propertyFillSkippedByEditLock).toBe(true);
  });

  it("★所有者だけの反映(ownersOnly)では触らない", async () => {
    pm.property.findUnique.mockResolvedValue({ ...UNIT });
    await processRegistryPdf({
      session,
      text: "dummy",
      propertyId: PROP_ID,
      fileName: "謄本.pdf",
      edited: undefined,
      pdfBuffer: null,
      certificateType: "owner",
      ownersOnly: true,
    } as Parameters<typeof processRegistryPdf>[0]);
    expect(pm.property.updateMany).not.toHaveBeenCalled();
  });
});
