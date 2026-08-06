/**
 * 有料取得の請求種別(owner|all)が processRegistryPdf の振る舞いに与える影響。
 *
 * ⚠**全部事項(all)は所有者を物件へ反映しない**(業務データの正しさ・@codex 設計指摘 P1)。
 * 全部事項には抹消された旧所有者が載り、今の解析は現在/抹消を区別できないため、
 * 旧所有者を現在の所有者として登録すると DM 宛先などが誤る。all は PDF 添付のみに留める。
 * 所有者事項(owner)・手動取込(種別 undefined)は従来どおり反映する。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({
  default: {
    property: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    owner: { findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    propertyOwner: { findFirst: vi.fn(), create: vi.fn() },
    importJob: { create: vi.fn(), update: vi.fn() },
    importJobRow: { create: vi.fn() },
    attachment: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));
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
vi.mock("@/lib/pdf-registry-parser", () => ({
  parseRegistryText: vi.fn(),
}));
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

import prisma from "@/lib/prisma";
import { parseRegistryText } from "@/lib/pdf-registry-parser";
import { getStorage } from "@/lib/storage";
import { processRegistryPdf } from "@/lib/registry-pdf/process";

const SESSION_ID = "user-1";
const PROP_ID = "11111111-1111-4111-8111-111111111111";
const PDF = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

const pm = prisma as unknown as {
  property: { findUnique: Mock; update: Mock };
  owner: { findMany: Mock; create: Mock; updateMany: Mock };
  propertyOwner: { findFirst: Mock; create: Mock };
  importJob: { create: Mock; update: Mock };
  importJobRow: { create: Mock };
  attachment: { create: Mock };
  $transaction: Mock;
};

const session = { id: SESSION_ID, role: "admin", email: "u@test", name: "U" };

beforeEach(() => {
  vi.clearAllMocks();
  // Mode A: 対象物件は既存でアクセス可。
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
  pm.propertyOwner.findFirst.mockResolvedValue(null);
  pm.propertyOwner.create.mockResolvedValue({});
  pm.attachment.create.mockResolvedValue({ id: "att-1" });
  pm.$transaction.mockImplementation((cb: (tx: typeof prisma) => unknown) =>
    cb(prisma),
  );
  (getStorage().upload as Mock).mockResolvedValue({ url: "/uploads/x.pdf", key: "x.pdf" });
  // 解析結果に所有者を1人含める。
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
});

async function run(certificateType?: "owner" | "all") {
  return processRegistryPdf({
    session,
    text: "dummy",
    propertyId: PROP_ID,
    fileName: "謄本.pdf",
    edited: undefined,
    pdfBuffer: PDF,
    certificateType,
  });
}

describe("⚠全部事項(all)は所有者を反映しない (@codex 設計指摘 P1)", () => {
  it("all: 所有者を物件へ紐づけない(旧所有者混入の防止)", async () => {
    await run("all");
    expect(pm.propertyOwner.create).not.toHaveBeenCalled();
    expect(pm.owner.create).not.toHaveBeenCalled();
  });

  it("all: それでも PDF は添付する(取得自体は無駄にしない)", async () => {
    await run("all");
    expect(pm.attachment.create).toHaveBeenCalledTimes(1);
    expect(pm.attachment.create.mock.calls[0][0].data).toMatchObject({
      type: "registry",
      registryCertificateType: "all",
    });
  });
});

describe("所有者事項(owner)・種別なしは従来どおり反映する", () => {
  it("owner: 所有者を反映し、添付に種別ラベルを付ける", async () => {
    await run("owner");
    expect(pm.propertyOwner.create).toHaveBeenCalledTimes(1);
    expect(pm.attachment.create.mock.calls[0][0].data).toMatchObject({
      registryCertificateType: "owner",
    });
  });

  it("種別なし(手動取込): 従来どおり反映し、添付の種別は null", async () => {
    await run(undefined);
    expect(pm.propertyOwner.create).toHaveBeenCalledTimes(1);
    expect(pm.attachment.create.mock.calls[0][0].data.registryCertificateType).toBeNull();
  });
});
