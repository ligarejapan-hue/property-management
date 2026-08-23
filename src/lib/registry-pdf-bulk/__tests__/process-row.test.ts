import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// #402: 実装が lockPropertyRow を import するようになった。実体は
// property-record-guard → api-helpers → next-auth と辿って **env=node の vitest では
// 解決できない**([[custom-skills]] ship の既知の罠)。丸ごと差し替える。
vi.mock("@/lib/property-record-guard", () => ({ lockPropertyRow: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: {
    importJobRow: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    attachment: {
      findFirst: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    property: {
      findUnique: vi.fn(),
    },
    // #402: 添付作成は「親行ロック → tx.attachment.create」の tx 内になった。
    $queryRaw: vi.fn(async () => [{ id: "p" }]),
    $transaction: vi.fn(),
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
import { writeAuditLog } from "@/lib/audit";
import { processRegistryPdfBulkRow } from "../process-row";
import { buildPropertyIndex } from "../match";

type PM = {
  importJobRow: { findUnique: Mock; updateMany: Mock };
  attachment: { findFirst: Mock; create: Mock; delete: Mock };
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
  // #402: $transaction は同一 mock を tx として渡す(既存アサーションを tx 経由でも通す)。
  (prisma as unknown as { $transaction: Mock }).$transaction.mockImplementation(
    async (fn: (tx: unknown) => unknown) => fn(prisma),
  );
  (prisma as unknown as { $queryRaw: Mock }).$queryRaw.mockResolvedValue([
    { id: "p" },
  ]);
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
    // 監査detailはID系のみ(fileName=所在入りは記録しない・@codex PR#256 P1)
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        targetTable: "attachments",
        targetId: "att1",
        detail: { propertyId: "p1", jobId: "j1", rowId: "r1" },
      }),
    );
  });

  it("行確定が失敗したら添付を取り消してから error 確定する(@codex PR#256 P2)", async () => {
    pm.importJobRow.findUnique.mockResolvedValue(
      makeRow({
        fileName:
          "世田谷区上馬２丁目７５２－３不動産登記（建物所有者事項）2024121200118150.PDF",
        stagedKey: "import-staging/registry-pdf/j1/1.pdf",
        requestNumber: "2024121200118150",
        location: "世田谷区上馬２丁目７５２－３",
      }),
    );
    // 1回目(success確定)=DB瞬断で失敗・以降(error確定)=成功
    pm.importJobRow.updateMany.mockRejectedValueOnce(new Error("db down"));
    const outcome = await processRegistryPdfBulkRow({
      jobId: "j1",
      rowId: "r1",
      index: INDEX,
      executor: EXEC,
    });
    expect(outcome).toBe("error");
    // 添付undo(レコード→blob の順・uploadedKey側のみ)
    expect(pm.attachment.delete).toHaveBeenCalledWith({
      where: { id: "att1" },
    });
    expect(storageMock.delete).toHaveBeenCalledWith(
      "properties/p1/registry/x.pdf",
    );
    // error確定は outer catch 経由で実施される
    const finalize = pm.importJobRow.updateMany.mock.calls.at(-1)![0];
    expect(finalize.data.status).toBe("error");
  });

  it("並行確定済み(count=0)なら添付を取り消して noop(行状態には触れない)", async () => {
    pm.importJobRow.findUnique.mockResolvedValue(
      makeRow({
        fileName:
          "世田谷区上馬２丁目７５２－３不動産登記（建物所有者事項）2024121200118151.PDF",
        stagedKey: "import-staging/registry-pdf/j1/1.pdf",
        requestNumber: "2024121200118151",
        location: "世田谷区上馬２丁目７５２－３",
      }),
    );
    pm.importJobRow.updateMany.mockResolvedValue({ count: 0 });
    const outcome = await processRegistryPdfBulkRow({
      jobId: "j1",
      rowId: "r1",
      index: INDEX,
      executor: EXEC,
    });
    expect(outcome).toBe("noop");
    expect(pm.attachment.delete).toHaveBeenCalledWith({
      where: { id: "att1" },
    });
    expect(storageMock.delete).toHaveBeenCalledWith(
      "properties/p1/registry/x.pdf",
    );
    // 行状態・stagingには触れない(確定は1回試行のみ・staging削除なし)
    expect(pm.importJobRow.updateMany).toHaveBeenCalledTimes(1);
    expect(storageMock.delete).not.toHaveBeenCalledWith(
      "import-staging/registry-pdf/j1/1.pdf",
    );
  });

  it("請求番号dup-checkは所属物件のある添付のみを対象とする(物件削除済みの孤児添付を永久ヒットさせない)", async () => {
    pm.importJobRow.findUnique.mockResolvedValue(
      makeRow({
        fileName: "世田谷区上馬２丁目７５２－３不動産登記（建物所有者事項）2024121200118150.PDF",
        stagedKey: "import-staging/registry-pdf/j1/1.pdf",
        requestNumber: "2024121200118150",
        location: "世田谷区上馬２丁目７５２－３",
      }),
    );
    await processRegistryPdfBulkRow({
      jobId: "j1", rowId: "r1", index: INDEX, executor: EXEC,
    });
    expect(pm.attachment.findFirst).toHaveBeenCalledTimes(1);
    const arg = pm.attachment.findFirst.mock.calls[0][0];
    expect(arg.where).toEqual(
      expect.objectContaining({ propertyId: { not: null } }),
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
      // 実データでは次行のタイトルが付着する(「所有者一覧表 （建物）」)。
      // process-row 側のクリーンアップ(最初の空白で切る)で所在部分だけ残るはず。
      address: "世田谷区上馬２丁目７５２－３ 所有者一覧表 （建物）",
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

  it("複数候補は、内容フォールバックも一意化できなければ needs_review(候補件数を記録)", async () => {
    // multiple でも内容フォールバックを試みる仕様のため、明示的に「一致しない」内容を
    // 返すモックを設定する(未設定だと偶発的な例外に依存してしまうため)。
    (extractTextFromPdf as Mock).mockResolvedValue("dummy text");
    (parseRegistryText as Mock).mockReturnValue({
      address: null,
      realEstateNumber: null,
    });
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

  it("複数候補でもPDF内容の不動産番号で一意化されれば success(matchedVia=content)", async () => {
    const idx = buildPropertyIndex([
      { id: "p3", address: "世田谷区等々力２丁目３４－７３", realEstateNumber: "9998887776665" },
      { id: "p4", address: "世田谷区等々力２丁目３４－７３", realEstateNumber: null },
    ]);
    (extractTextFromPdf as Mock).mockResolvedValue("dummy text");
    (parseRegistryText as Mock).mockReturnValue({
      address: "世田谷区等々力２丁目３４－７３ 所有者一覧表 （土地）",
      realEstateNumber: "9998887776665",
    });
    pm.importJobRow.findUnique.mockResolvedValue(
      makeRow({
        fileName: "世田谷区等々力２丁目３４－７３不動産登記（土地所有者事項）2024121100711699.PDF",
        stagedKey: "import-staging/registry-pdf/j1/1.pdf",
        requestNumber: "2024121100711699",
        location: "世田谷区等々力２丁目３４－７３",
      }),
    );
    const outcome = await processRegistryPdfBulkRow({
      jobId: "j1", rowId: "r1", index: idx, executor: EXEC,
    });
    expect(outcome).toBe("success");
    expect(pm.attachment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ propertyId: "p3" }),
        select: { id: true },
      }),
    );
    const finalize = pm.importJobRow.updateMany.mock.calls.at(-1)![0];
    expect(finalize.data.rawData).toEqual(
      expect.objectContaining({
        matchedVia: "content",
        matchedBy: "real_estate_number",
      }),
    );
  });

  it("staging読取不能は error(実体が無い可能性のためstagingは削除しない)", async () => {
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
    expect(storageMock.delete).not.toHaveBeenCalled();
  });

  it("取込データ不完全(stagedKeyなし)は error(削除対象キーが無いのでdeleteは呼ばれない)", async () => {
    pm.importJobRow.findUnique.mockResolvedValue(
      makeRow({
        fileName: "世田谷区上馬２丁目７５２－３不動産登記（建物所有者事項）2024121200118152.PDF",
        requestNumber: "2024121200118152",
        location: "世田谷区上馬２丁目７５２－３",
        // stagedKey無し
      }),
    );
    const outcome = await processRegistryPdfBulkRow({
      jobId: "j1", rowId: "r1", index: INDEX, executor: EXEC,
    });
    expect(outcome).toBe("error");
    expect(storageMock.delete).not.toHaveBeenCalled();
  });

  it("バリデーション失敗(ファイルサイズ超過)は error で確定しstagingも削除する", async () => {
    storageMock.read.mockResolvedValue({
      body: Buffer.alloc(8 * 1024 * 1024 + 1),
      contentType: "application/pdf",
      size: 8 * 1024 * 1024 + 1,
    });
    pm.importJobRow.findUnique.mockResolvedValue(
      makeRow({
        fileName: "世田谷区上馬２丁目７５２－３不動産登記（建物所有者事項）2024121200118153.PDF",
        stagedKey: "import-staging/registry-pdf/j1/1.pdf",
        requestNumber: "2024121200118153",
        location: "世田谷区上馬２丁目７５２－３",
      }),
    );
    const outcome = await processRegistryPdfBulkRow({
      jobId: "j1", rowId: "r1", index: INDEX, executor: EXEC,
    });
    expect(outcome).toBe("error");
    const finalize = pm.importJobRow.updateMany.mock.calls.at(-1)![0];
    expect(finalize.data.rawData).toEqual(
      expect.objectContaining({ reason: "validation_failed" }),
    );
    expect(storageMock.delete).toHaveBeenCalledWith(
      "import-staging/registry-pdf/j1/1.pdf",
    );
  });

  it("予期しないエラー(添付レコード作成失敗)は error で確定しstaging・孤児アップロード先の両方を削除する", async () => {
    pm.attachment.create.mockRejectedValue(new Error("db down"));
    pm.importJobRow.findUnique.mockResolvedValue(
      makeRow({
        fileName: "世田谷区上馬２丁目７５２－３不動産登記（建物所有者事項）2024121200118154.PDF",
        stagedKey: "import-staging/registry-pdf/j1/1.pdf",
        requestNumber: "2024121200118154",
        location: "世田谷区上馬２丁目７５２－３",
      }),
    );
    const outcome = await processRegistryPdfBulkRow({
      jobId: "j1", rowId: "r1", index: INDEX, executor: EXEC,
    });
    expect(outcome).toBe("error");
    const finalize = pm.importJobRow.updateMany.mock.calls.at(-1)![0];
    expect(finalize.data.rawData).toEqual(
      expect.objectContaining({ reason: "unexpected_error" }),
    );
    // staging(未処理の所有者PII)は保持理由が無いので削除する
    expect(storageMock.delete).toHaveBeenCalledWith(
      "import-staging/registry-pdf/j1/1.pdf",
    );
    // 孤児化したアップロード先も既存動作で削除される
    expect(storageMock.delete).toHaveBeenCalledWith(
      "properties/p1/registry/x.pdf",
    );
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
