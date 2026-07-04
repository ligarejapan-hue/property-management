import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({
  default: {
    importJobRow: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    attachment: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    property: {
      findUnique: vi.fn(),
    },
  },
}));
vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...actual,
    getStorage: vi.fn(),
  };
});
vi.mock("@/lib/pdf-extract", () => ({
  extractTextFromPdf: vi.fn(),
}));
vi.mock("@/lib/pdf-registry-parser", () => ({
  parseRegistryText: vi.fn(),
}));
vi.mock("@/lib/property-access", () => ({
  canAccessPropertyRecord: vi.fn(() => true),
}));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

import prisma from "@/lib/prisma";
import { getStorage } from "@/lib/storage";
import { extractTextFromPdf } from "@/lib/pdf-extract";
import { parseRegistryText } from "@/lib/pdf-registry-parser";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { processRegistryPdfBulkRow } from "../process-row";
import { buildPropertyIndex } from "../match";

type PM = {
  importJobRow: { findUnique: Mock; updateMany: Mock };
  attachment: { findFirst: Mock; create: Mock };
  property: { findUnique: Mock };
};
const pm = prisma as unknown as PM;

const EXEC = { id: "u1", role: "admin" };
const INDEX = buildPropertyIndex([
  { id: "p1", address: "世田谷区上馬２丁目７５２－３", realEstateNumber: null },
  { id: "p3", address: "世田谷区等々力２丁目３４－７３", realEstateNumber: null },
  { id: "p4", address: "世田谷区等々力２丁目３４－７３", realEstateNumber: null },
]);

// PDFヘッダを持つ最小バッファ
const PDF_BUF = Buffer.from("%PDF-1.4 test");

function makeRow(rawData: Record<string, string>) {
  return {
    id: "r1",
    jobId: "j1",
    rowNumber: 1,
    status: "pending",
    rawData,
    errorMessage: null,
    createdId: null,
  };
}

const storageMock = {
  read: vi.fn(),
  upload: vi.fn(),
  delete: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  (getStorage as Mock).mockReturnValue(storageMock);
  (canAccessPropertyRecord as Mock).mockReturnValue(true);
  pm.importJobRow.updateMany.mockResolvedValue({ count: 1 });
  pm.attachment.findFirst.mockResolvedValue(null);
  pm.property.findUnique.mockResolvedValue({ createdBy: "u1", assignedTo: null });
  storageMock.read.mockResolvedValue({
    body: PDF_BUF,
    contentType: "application/pdf",
    size: PDF_BUF.length,
  });
  storageMock.upload.mockResolvedValue({
    url: "/uploads/properties/p1/registry/x.pdf",
    key: "properties/p1/registry/x.pdf",
  });
  storageMock.delete.mockResolvedValue(undefined);
  pm.attachment.create.mockResolvedValue({ id: "att1" });
});

describe("processRegistryPdfBulkRow", () => {
  it("所在一致で添付し success で確定・stagingを削除する", async () => {
    pm.importJobRow.findUnique.mockResolvedValue(
      makeRow({
        fileName: "世田谷区上馬２丁目７５２－３不動産登記（建物所有者事項）2024121200118150.PDF",
        stagedKey: "import-staging/registry-pdf/j1/1.pdf",
        requestNumber: "2024121200118150",
        location: "世田谷区上馬２丁目７５２－３",
      }),
    );
    const outcome = await processRegistryPdfBulkRow({
      jobId: "j1",
      rowId: "r1",
      index: INDEX,
      executor: EXEC,
    });
    expect(outcome).toBe("success");
    expect(pm.attachment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "registry",
          propertyId: "p1",
          uploadedBy: "u1",
          mimeType: "application/pdf",
        }),
        select: { id: true },
      }),
    );
    // 確定は status=pending 条件付き updateMany(atomic)
    const finalize = pm.importJobRow.updateMany.mock.calls.at(-1)![0];
    expect(finalize.where).toEqual({ id: "r1", status: "pending" });
    expect(finalize.data.status).toBe("success");
    expect(finalize.data.createdId).toBe("p1");
    expect(storageMock.delete).toHaveBeenCalledWith(
      "import-staging/registry-pdf/j1/1.pdf",
    );
  });

  it("請求番号が既存添付にあれば skipped(重複)でstagingも削除", async () => {
    pm.attachment.findFirst.mockResolvedValue({ id: "old", propertyId: "p1" });
    pm.importJobRow.findUnique.mockResolvedValue(
      makeRow({
        fileName: "世田谷区上馬２丁目７５２－３不動産登記（建物所有者事項）2024121200118150.PDF",
        stagedKey: "import-staging/registry-pdf/j1/1.pdf",
        requestNumber: "2024121200118150",
        location: "世田谷区上馬２丁目７５２－３",
      }),
    );
    const outcome = await processRegistryPdfBulkRow({
      jobId: "j1", rowId: "r1", index: INDEX, executor: EXEC,
    });
    expect(outcome).toBe("skipped");
    expect(pm.attachment.create).not.toHaveBeenCalled();
    const finalize = pm.importJobRow.updateMany.mock.calls.at(-1)![0];
    expect(finalize.data.status).toBe("skipped");
    expect(String(finalize.data.errorMessage)).toMatch(/^重複/);
    expect(storageMock.delete).toHaveBeenCalled();
  });

  it("所在不一致はPDF内容フォールバックでも0件なら needs_review(staging保持)", async () => {
    (extractTextFromPdf as Mock).mockResolvedValue("dummy text");
    (parseRegistryText as Mock).mockReturnValue({
      address: "杉並区高円寺南１丁目１－１",
      realEstateNumber: null,
    });
    pm.importJobRow.findUnique.mockResolvedValue(
      makeRow({
        fileName: "杉並区高円寺南１丁目１－１不動産登記（土地所有者事項）2024121200999999.PDF",
        stagedKey: "import-staging/registry-pdf/j1/1.pdf",
        requestNumber: "2024121200999999",
        location: "杉並区高円寺南１丁目１－１",
      }),
    );
    const outcome = await processRegistryPdfBulkRow({
      jobId: "j1", rowId: "r1", index: INDEX, executor: EXEC,
    });
    expect(outcome).toBe("needs_review");
    expect(pm.attachment.create).not.toHaveBeenCalled();
    expect(storageMock.delete).not.toHaveBeenCalled();
    const finalize = pm.importJobRow.updateMany.mock.calls.at(-1)![0];
    expect(finalize.data.status).toBe("needs_review");
  });

  it("所在不一致でもPDF内容フォールバックが一致すれば success(matchedVia=content)", async () => {
    (extractTextFromPdf as Mock).mockResolvedValue("dummy text");
    (parseRegistryText as Mock).mockReturnValue({
      address: "世田谷区上馬２丁目７５２－３",
      realEstateNumber: null,
    });
    pm.importJobRow.findUnique.mockResolvedValue(
      makeRow({
        fileName: "杉並区高円寺南１丁目１－１不動産登記（土地所有者事項）2024121200999998.PDF",
        stagedKey: "import-staging/registry-pdf/j1/1.pdf",
        requestNumber: "2024121200999998",
        location: "杉並区高円寺南１丁目１－１",
      }),
    );
    const outcome = await processRegistryPdfBulkRow({
      jobId: "j1", rowId: "r1", index: INDEX, executor: EXEC,
    });
    expect(outcome).toBe("success");
    expect(pm.attachment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          propertyId: "p1",
        }),
        select: { id: true },
      }),
    );
    const finalize = pm.importJobRow.updateMany.mock.calls.at(-1)![0];
    expect(finalize.data.rawData).toEqual(
      expect.objectContaining({ matchedVia: "content" }),
    );
  });

  it("複数候補は needs_review(候補件数を記録)", async () => {
    pm.importJobRow.findUnique.mockResolvedValue(
      makeRow({
        fileName: "世田谷区等々力２丁目３４－７３不動産登記（土地所有者事項）2024121100711621.PDF",
        stagedKey: "import-staging/registry-pdf/j1/1.pdf",
        requestNumber: "2024121100711621",
        location: "世田谷区等々力２丁目３４－７３",
      }),
    );
    const outcome = await processRegistryPdfBulkRow({
      jobId: "j1", rowId: "r1", index: INDEX, executor: EXEC,
    });
    expect(outcome).toBe("needs_review");
    const finalize = pm.importJobRow.updateMany.mock.calls.at(-1)![0];
    expect(String(finalize.data.errorMessage)).toContain("複数");
  });

  it("staging読取不能は error", async () => {
    storageMock.read.mockResolvedValue(null);
    pm.importJobRow.findUnique.mockResolvedValue(
      makeRow({
        fileName: "世田谷区上馬２丁目７５２－３不動産登記（建物所有者事項）2024121200118151.PDF",
        stagedKey: "import-staging/registry-pdf/j1/1.pdf",
        requestNumber: "2024121200118151",
        // location無し → 内容フォールバックに行く前に staging read が必要
      }),
    );
    (extractTextFromPdf as Mock).mockResolvedValue("x");
    (parseRegistryText as Mock).mockReturnValue({ address: null, realEstateNumber: null });
    const outcome = await processRegistryPdfBulkRow({
      jobId: "j1", rowId: "r1", index: INDEX, executor: EXEC,
    });
    expect(outcome).toBe("error");
  });

  it("pending以外の行は noop(再enqueue耐性)", async () => {
    pm.importJobRow.findUnique.mockResolvedValue({
      ...makeRow({ fileName: "x", stagedKey: "k" }),
      status: "success",
    });
    const outcome = await processRegistryPdfBulkRow({
      jobId: "j1", rowId: "r1", index: INDEX, executor: EXEC,
    });
    expect(outcome).toBe("noop");
    expect(pm.importJobRow.updateMany).not.toHaveBeenCalled();
  });

  it("アクセス権が無い物件への一致は needs_review", async () => {
    (canAccessPropertyRecord as Mock).mockReturnValue(false);
    pm.importJobRow.findUnique.mockResolvedValue(
      makeRow({
        fileName: "世田谷区上馬２丁目７５２－３不動産登記（建物所有者事項）2024121200118150.PDF",
        stagedKey: "import-staging/registry-pdf/j1/1.pdf",
        requestNumber: "2024121200118150",
        location: "世田谷区上馬２丁目７５２－３",
      }),
    );
    const outcome = await processRegistryPdfBulkRow({
      jobId: "j1", rowId: "r1", index: INDEX, executor: EXEC,
    });
    expect(outcome).toBe("needs_review");
    expect(pm.attachment.create).not.toHaveBeenCalled();
  });
});
