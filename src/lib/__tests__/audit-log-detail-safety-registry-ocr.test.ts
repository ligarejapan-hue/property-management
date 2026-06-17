/**
 * audit-log-detail-safety: action "registry_ocr_draft" の登録テスト。
 *
 * OCR 下書き生成の非PII メタ（status/pages/charCount/previewGenerated/errorCode）が
 * sanitize 後も auditor に有用な形で残ること、かつ万一 raw text / 氏名が混入しても
 * redact される（defense-in-depth）ことを保証する。
 */
import { describe, it, expect } from "vitest";
import { sanitizeAuditDetail, REDACTED } from "@/lib/audit-log-detail-safety";

describe("sanitizeAuditDetail: registry_ocr_draft", () => {
  it("非PII メタを sanitize 後も保持", () => {
    const out = sanitizeAuditDetail("registry_ocr_draft", {
      status: "succeeded",
      pages: 2,
      charCount: 1234,
      previewGenerated: true,
      errorCode: null,
    }) as Record<string, unknown>;

    expect(out.status).toBe("succeeded");
    expect(out.pages).toBe(2);
    expect(out.charCount).toBe(1234);
    expect(out.previewGenerated).toBe(true);
    expect(out.errorCode).toBe(null);
    expect(JSON.stringify(out)).not.toContain(REDACTED);
  });

  it("万一 raw OCR text / 氏名キーが混入しても redact される", () => {
    const out = sanitizeAuditDetail("registry_ocr_draft", {
      status: "succeeded",
      ocrText: "所有者 山田太郎 ...", // 非allowlist → redact
      ownerName: "山田太郎", // /name/i, /owner/i denylist → redact
    }) as Record<string, unknown>;

    expect(out.status).toBe("succeeded");
    expect(out.ocrText).toBe(REDACTED);
    expect(out.ownerName).toBe(REDACTED);
  });
});
