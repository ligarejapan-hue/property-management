/**
 * 同じ謄本PDFを取り直したときに、**住所の無い所有者が増えない**こと。
 *
 * 背景（@codex #394 R6 P2）: 謄本PDFの保存は処理の最後にあり、保存に失敗しても取込自体は
 * 成功扱い（警告のみ）。つまり「PDFだけ入らなかったのでやり直す」が現実に起きる。
 * 住所の無い所有者は「名前だけでの自動統合はしない」規則のため、やり直すたびに
 * 新しい所有者として作られ、物件に同じ人が並ぶ。
 * ⚠**グローバルな名前だけの統合は従来どおり禁止**（同姓同名の別人を混ぜない）。
 *   再利用するのは**その物件に既に紐づいている**所有者だけ。
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
vi.mock("@/lib/change-log", () => ({ recordChangeLog: vi.fn() }));
vi.mock("@/lib/pdf-registry-parser", () => ({ parseRegistryText: vi.fn() }));
vi.mock("@/lib/storage", () => {
  const upload = vi.fn();
  const del = vi.fn();
  return {
    getStorage: () => ({ upload, delete: del }),
    validateFile: vi.fn(() => null),
    ALLOWED_ATTACHMENT_MIMES: ["application/pdf"],
  };
});

import prisma from "@/lib/prisma";
import { parseRegistryText } from "@/lib/pdf-registry-parser";
import { getStorage } from "@/lib/storage";
import { processRegistryPdf } from "@/lib/registry-pdf/process";

const SESSION_ID = "user-1";
const PROP_ID = "11111111-1111-4111-8111-111111111111";
const PDF = Buffer.from([1, 2, 3, 4, 5]);

const pm = prisma as unknown as {
  property: { findUnique: Mock; update: Mock };
  owner: { findMany: Mock; create: Mock; updateMany: Mock };
  propertyOwner: { findFirst: Mock; findMany: Mock; create: Mock };
  importJob: { create: Mock; update: Mock };
  importJobRow: { create: Mock };
  attachment: { create: Mock };
  $transaction: Mock;
};

const session = { id: SESSION_ID, role: "admin", email: "u@test", name: "U" };

/** その物件に既に紐づいている所有者（取り直し前の状態）を仕込む。 */
const linkedOwners = (
  owners: Array<{
    id: string;
    name: string;
    address?: string | null;
    isArchived?: boolean;
  }>,
) => {
  pm.propertyOwner.findMany.mockResolvedValue(
    owners.map((o) => ({
      owner: {
        id: o.id,
        name: o.name,
        address: o.address ?? null,
        isArchived: o.isArchived ?? false,
        corporateNumber: null,
      },
    })),
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  pm.property.findUnique.mockResolvedValue({
    id: PROP_ID,
    createdBy: SESSION_ID,
    assignedTo: null,
    address: "東京都千代田区一番町1",
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
  pm.attachment.create.mockResolvedValue({ id: "att-1" });
  pm.$transaction.mockImplementation((cb: (tx: typeof prisma) => unknown) =>
    cb(prisma),
  );
  (getStorage().upload as Mock).mockResolvedValue({
    url: "/uploads/x.pdf",
    key: "x.pdf",
  });
  // ⚠所有者に**住所が無い**のが今回の主題（住所ありは従来どおり全体照合される）。
  (parseRegistryText as Mock).mockReturnValue({
    realEstateNumber: null,
    address: "東京都千代田区一番町1",
    lotNumber: null,
    buildingNumber: null,
    landCategory: null,
    area: null,
    owners: [{ name: "山田太郎", address: null, share: null }],
    warnings: [],
    confidence: 0.9,
  });
});

const run = () =>
  processRegistryPdf({
    session,
    text: "dummy",
    propertyId: PROP_ID,
    fileName: "謄本.pdf",
    edited: undefined,
    pdfBuffer: PDF,
    certificateType: "owner",
  });

describe("同じ謄本を取り直しても住所なしの所有者が増えない", () => {
  it("既に同名・住所なしの所有者が紐づいていれば、新しく作らない", async () => {
    linkedOwners([{ id: "owner-existing", name: "山田太郎" }]);
    // 既にリンク済み＝リンクも作らない。
    pm.propertyOwner.findFirst.mockResolvedValue({ propertyId: PROP_ID });
    await run();
    expect(pm.owner.create).not.toHaveBeenCalled();
    expect(pm.propertyOwner.create).not.toHaveBeenCalled();
  });

  it("初回（紐づきなし）は従来どおり新規作成する", async () => {
    linkedOwners([]);
    await run();
    expect(pm.owner.create).toHaveBeenCalledTimes(1);
  });

  it("紐づいているのが別名なら新規作成する（別人を混ぜない）", async () => {
    linkedOwners([{ id: "owner-other", name: "鈴木一郎" }]);
    await run();
    expect(pm.owner.create).toHaveBeenCalledTimes(1);
  });

  it("アーカイブ済みの紐づきは再利用しない", async () => {
    linkedOwners([{ id: "owner-arch", name: "山田太郎", isArchived: true }]);
    await run();
    expect(pm.owner.create).toHaveBeenCalledTimes(1);
  });

  it("⚠住所ありの所有者は従来どおり**全体**から照合する（この変更で経路を変えない）", async () => {
    (parseRegistryText as Mock).mockReturnValue({
      realEstateNumber: null,
      address: "東京都千代田区一番町1",
      lotNumber: null,
      buildingNumber: null,
      landCategory: null,
      area: null,
      owners: [{ name: "山田太郎", address: "東京都港区1-1", share: null }],
      warnings: [],
      confidence: 0.9,
    });
    linkedOwners([{ id: "owner-existing", name: "山田太郎" }]);
    await run();
    // 住所ありは owner.findMany（全体照合）を使う。物件内の再利用に流さない。
    expect(pm.owner.findMany).toHaveBeenCalled();
  });
});
