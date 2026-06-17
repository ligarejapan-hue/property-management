/**
 * POST /api/import/registry-pdf/ocr-draft の統合テスト。
 *
 * - 認可: import:write + admin（非 admin/権限欠如は 403）
 * - OCR 未設定は 501（現行挙動維持）
 * - 成功は preview 形（extractionMethod=local_ocr）を返し DB 書込なし
 * - OCR 失敗は 502（UI は手動貼付へ fallback）
 * permissions / parseRegistryText は実物。api-helpers / audit / OCR client は mock。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type { ApiSession, PermissionEntry } from "@/lib/api-helpers";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
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
    getApiSession: vi.fn(),
    getUserPermissions: vi.fn(),
    apiResponse: vi.fn((data: unknown, status = 200) =>
      Response.json(data, { status }),
    ),
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
  };
});

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

vi.mock("@/lib/registry-ocr/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/registry-ocr/client")>(
    "@/lib/registry-ocr/client",
  );
  return {
    ...actual,
    isRegistryOcrConfigured: vi.fn(),
    requestOcrText: vi.fn(),
  };
});

import {
  getApiSession,
  getUserPermissions,
  ApiError,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import {
  isRegistryOcrConfigured,
  requestOcrText,
  RegistryOcrError,
} from "@/lib/registry-ocr/client";
import { POST } from "../../app/api/import/registry-pdf/ocr-draft/route";

const getApiSessionMock = getApiSession as unknown as Mock;
const getUserPermissionsMock = getUserPermissions as unknown as Mock;
const isConfiguredMock = isRegistryOcrConfigured as unknown as Mock;
const requestOcrMock = requestOcrText as unknown as Mock;
const writeAuditLogMock = writeAuditLog as unknown as Mock;

const IMPORT_WRITE: PermissionEntry[] = [
  { resource: "import", action: "write", granted: true },
];

function session(role: string): ApiSession {
  return { id: "u1", email: "u@e.com", name: "U", role } as ApiSession;
}
function pdfReq(): never {
  const fd = new FormData();
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]); // %PDF-1
  fd.append("file", new File([bytes], "scan.pdf", { type: "application/pdf" }));
  return new Request("http://t/ocr", { method: "POST", body: fd }) as never;
}
function jsonReq(): never {
  return new Request("http://t/ocr", {
    method: "POST",
    body: JSON.stringify({}),
    headers: { "content-type": "application/json" },
  }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  getApiSessionMock.mockResolvedValue(session("admin"));
  getUserPermissionsMock.mockResolvedValue(IMPORT_WRITE);
  isConfiguredMock.mockReturnValue(true);
  requestOcrMock.mockResolvedValue({
    text: "不動産番号: 1234567890123\n所在: 東京都...",
    pages: 1,
    warnings: [],
  });
});

describe("POST ocr-draft", () => {
  it("未認証 → 401", async () => {
    getApiSessionMock.mockRejectedValue(new ApiError(401, "未認証", "UNAUTHORIZED"));
    const res = await POST(pdfReq());
    expect(res.status).toBe(401);
  });

  it("import:write 無 → 403", async () => {
    getUserPermissionsMock.mockResolvedValue([]);
    const res = await POST(pdfReq());
    expect(res.status).toBe(403);
  });

  it("非 admin → 403", async () => {
    getApiSessionMock.mockResolvedValue(session("office_staff"));
    const res = await POST(pdfReq());
    expect(res.status).toBe(403);
  });

  it("OCR 未設定 → 501（現行挙動維持）", async () => {
    isConfiguredMock.mockReturnValue(false);
    const res = await POST(pdfReq());
    expect(res.status).toBe(501);
    expect(requestOcrMock).not.toHaveBeenCalled();
  });

  it("multipart でない → 400", async () => {
    const res = await POST(jsonReq());
    expect(res.status).toBe(400);
  });

  it("成功 → 200・extractionMethod=local_ocr・preview 返却", async () => {
    const res = await POST(pdfReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.extractionMethod).toBe("local_ocr");
    expect(body.extractionSource).toBe("scanned_pdf");
    expect(body.parsed).toBeTruthy();
    // 監査は succeeded・raw text を載せない
    expect(writeAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "registry_ocr_draft",
        detail: expect.objectContaining({ status: "succeeded", previewGenerated: true }),
      }),
    );
    const auditArg = writeAuditLogMock.mock.calls[0][0];
    expect(JSON.stringify(auditArg.detail)).not.toContain("不動産番号");
  });

  it("OCR 失敗 → 502（手動貼付 fallback）・監査 failed", async () => {
    requestOcrMock.mockRejectedValue(new RegistryOcrError("TIMEOUT", "timeout"));
    const res = await POST(pdfReq());
    expect(res.status).toBe(502);
    expect(writeAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ status: "failed", errorCode: "TIMEOUT" }),
      }),
    );
  });
});
