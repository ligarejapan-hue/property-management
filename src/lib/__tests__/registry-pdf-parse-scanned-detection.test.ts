/**
 * POST /api/import/registry-pdf/parse: scanned PDF 検知 (F-1)
 *
 * - PDF アップロード経路でテキスト抽出結果が空/極端に短い場合
 *   response.extractionSource === "likely_scanned" を返す
 * - response.isLikelyScanned が true
 * - parsed.warnings に画像化PDF注意の文言が先頭に追加される
 * - テキスト貼り付け経路は embedded_text 固定（短くても scanned 扱いしない）
 * - parse route は AuditLog を書かない（プレビュー専用）
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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
    getUserPermissions: vi.fn().mockResolvedValue([
      { resource: "import", action: "write", granted: true },
    ]),
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

vi.mock("@/lib/permissions", () => ({
  hasPermission: vi.fn().mockReturnValue(true),
}));

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

vi.mock("@/lib/pdf-registry-parser", () => ({
  parseRegistryText: vi.fn(),
}));

const { extractTextFromPdfMock } = vi.hoisted(() => ({
  extractTextFromPdfMock: vi.fn(),
}));
vi.mock("@/lib/pdf-extract", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/pdf-extract")
  >("@/lib/pdf-extract");
  return {
    ...actual,
    extractTextFromPdf: extractTextFromPdfMock,
    isPdfBuffer: vi.fn().mockReturnValue(true),
  };
});

import { parseRegistryText } from "@/lib/pdf-registry-parser";
import { writeAuditLog } from "@/lib/audit";
import { POST as PARSE_POST } from "../../app/api/import/registry-pdf/parse/route";

const PDF_HEADER = Buffer.from("%PDF-1.4\n", "utf8");

function makeMultipartRequest(pdfBytes: Buffer, fileName = "registry.pdf") {
  const form = new FormData();
  const blob = new Blob([new Uint8Array(pdfBytes)], { type: "application/pdf" });
  form.append("file", blob, fileName);
  return new Request("http://test/api/import/registry-pdf/parse", {
    method: "POST",
    body: form,
  });
}

function makeJsonRequest(text: string, fileName = "paste.txt") {
  // 取込 route は body を読む前に Content-Length を要求する(2026-08-02 監査)。
  // ブラウザの fetch は自動で付けるが、テストの new Request では明示が必要。
  const payload = JSON.stringify({ text, fileName });
  return new Request("http://test/api/import/registry-pdf/parse", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "content-length": String(Buffer.byteLength(payload)),
    },
    body: payload,
  });
}

const baseParsed = {
  realEstateNumber: null,
  address: null,
  lotNumber: null,
  buildingNumber: null,
  landCategory: null,
  area: null,
  owners: [],
  confidence: 0.4,
  warnings: [] as string[],
};

beforeEach(() => {
  vi.clearAllMocks();
  (parseRegistryText as ReturnType<typeof vi.fn>).mockReturnValue({
    ...baseParsed,
    warnings: [],
  });
});

describe("POST /api/import/registry-pdf/parse — scanned detection", () => {
  it("PDF アップロードでテキスト抽出が空のとき likely_scanned を返す", async () => {
    extractTextFromPdfMock.mockResolvedValue("");

    const req = makeMultipartRequest(PDF_HEADER);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await PARSE_POST(req as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.extractionSource).toBe("likely_scanned");
    expect(body.isLikelyScanned).toBe(true);
    expect(body.parsed.warnings[0]).toMatch(
      /画像化された謄本PDFの可能性|OCRは未対応/,
    );
  });

  it("PDF アップロードで十分なテキストがあれば embedded_text を返す", async () => {
    const longText =
      "不動産番号 1234567890123\n所在 東京都千代田区丸の内一丁目\n地番 1番1\n地目 宅地\n地積 150.00\n所有者 山田太郎";
    extractTextFromPdfMock.mockResolvedValue(longText);

    const req = makeMultipartRequest(PDF_HEADER);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await PARSE_POST(req as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.extractionSource).toBe("embedded_text");
    expect(body.isLikelyScanned).toBe(false);
    expect(
      body.parsed.warnings.some((w: string) => /画像化された謄本PDF/.test(w)),
    ).toBe(false);
  });

  it("テキスト貼り付け経路は短くても embedded_text 固定で scanned 警告を出さない", async () => {
    const req = makeJsonRequest("ごく短い貼り付け");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await PARSE_POST(req as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.extractionSource).toBe("embedded_text");
    expect(body.isLikelyScanned).toBe(false);
    expect(extractTextFromPdfMock).not.toHaveBeenCalled();
  });

  it("既存 warnings と scanned 警告が重複しない", async () => {
    extractTextFromPdfMock.mockResolvedValue("");
    (parseRegistryText as ReturnType<typeof vi.fn>).mockReturnValue({
      ...baseParsed,
      warnings: ["不動産番号を抽出できませんでした"],
    });

    const req = makeMultipartRequest(PDF_HEADER);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await PARSE_POST(req as any);
    const body = await res.json();

    const scannedWarnings = body.parsed.warnings.filter((w: string) =>
      /画像化された謄本PDF/.test(w),
    );
    expect(scannedWarnings).toHaveLength(1);
    expect(body.parsed.warnings).toContain("不動産番号を抽出できませんでした");
  });

  it("parse route は AuditLog を書かない（プレビュー専用）", async () => {
    extractTextFromPdfMock.mockResolvedValue("");

    const req = makeMultipartRequest(PDF_HEADER);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await PARSE_POST(req as any);

    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});
