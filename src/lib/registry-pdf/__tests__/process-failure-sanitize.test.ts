/**
 * 取込の失敗を記録するとき、**生のエラー文を残さない**経路(添付済み謄本からの反映)。
 *
 * ⚠`processRegistryPdf` はジョブ作成後の失敗を `ImportJobRow` に残すが、
 *   そこに `err.message` をそのまま入れている。データベースや保管庫の例外は、
 *   拒否した呼び出しの中身(登記由来の住所など)を文面に埋め込むことがある。
 *   1件ずつのボタン/まとめて反映は「見せたものだけ書く」を徹底する経路なので、
 *   この経路だけ**種類とコードに丸めて**残す(既存の手動取込・自動取得は従来どおり
 *   生の文面を残す=担当者の手がかりを失わない)。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    property: { findUnique: vi.fn(), update: vi.fn() },
    owner: { findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
    propertyOwner: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), count: vi.fn() },
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
vi.mock("@/lib/storage", () => ({
  getStorage: () => ({ upload: vi.fn(), delete: vi.fn() }),
  validateFile: vi.fn(() => null),
  ALLOWED_ATTACHMENT_MIMES: ["application/pdf"],
}));

import prisma from "@/lib/prisma";
import { parseRegistryText } from "@/lib/pdf-registry-parser";
import { processRegistryPdf } from "@/lib/registry-pdf/process";

const PROP_ID = "11111111-1111-4111-8111-111111111111";
const pm = prisma as unknown as {
  property: { findUnique: Mock };
  importJob: { create: Mock; update: Mock };
  importJobRow: { create: Mock };
};

/**
 * 住所を文面に埋め込んでくる例外(データベースの検証エラーの形)。
 * ⚠物件の住所(解析結果として記録に残る `extractedAddress`)とは**別の文字列**を使う。
 *   そうしないと「記録に残ってはいけない文面」と「残してよい物件の住所」を
 *   見分けられず、テストが空振りする。
 */
const LEAKED_TEXT = "東京都港区赤坂九丁目99番9号 山田花子";
const leakyError = () =>
  Object.assign(
    new Error(`Invalid invocation: rawData: { address: '${LEAKED_TEXT}' }`),
    { code: "P2009", name: "PrismaClientValidationError" },
  );

const run = (extra: Record<string, unknown> = {}) =>
  processRegistryPdf({
    session: { id: "user-1", role: "admin" },
    text: "dummy",
    propertyId: PROP_ID,
    fileName: "添付済みの謄本から所有者を反映",
    edited: undefined,
    pdfBuffer: null,
    certificateType: "owner",
    ...extra,
  });

beforeEach(() => {
  vi.clearAllMocks();
  (parseRegistryText as Mock).mockReturnValue({
    realEstateNumber: null,
    address: "東京都渋谷区神宮前三丁目12-3",
    lotNumber: null,
    buildingNumber: null,
    landCategory: null,
    area: null,
    owners: [{ name: "山田太郎", address: "東京都渋谷区神宮前三丁目12番3号", share: null }],
    warnings: [],
    confidence: 0.9,
  });
  pm.importJob.create.mockResolvedValue({ id: "job-1" });
  pm.importJob.update.mockResolvedValue({});
  pm.importJobRow.create.mockResolvedValue({});
  // ジョブ作成後に失敗させる(物件の読み取りで例外)
  pm.property.findUnique.mockRejectedValue(leakyError());
});

/** 失敗の記録に渡された内容。 */
const failureRow = () =>
  pm.importJobRow.create.mock.calls[0][0].data as {
    rawData: Record<string, unknown>;
    errorMessage: string;
  };

describe("失敗の記録（sanitizeFailureDetails）", () => {
  it("⚠指定した経路では、生のエラー文を記録に残さない", async () => {
    await expect(run({ sanitizeFailureDetails: true })).rejects.toThrow();

    const row = failureRow();
    const dump = JSON.stringify(row);
    expect(dump).not.toContain("赤坂九丁目");
    expect(dump).not.toContain("山田花子");
    expect(dump).not.toContain("rawData: {");
    // 追いかけられる情報(種類・コード)は残す
    expect(row.errorMessage).toContain("PrismaClientValidationError");
    expect(row.errorMessage).toContain("P2009");
    expect(String(row.rawData.reason)).toContain("PrismaClientValidationError");
  });

  it("指定しない経路（手動取込・自動取得）は従来どおり生の文面を残す", async () => {
    await expect(run()).rejects.toThrow();
    expect(failureRow().errorMessage).toContain("Invalid invocation");
  });
});
