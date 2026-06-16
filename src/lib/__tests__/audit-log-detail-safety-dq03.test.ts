/**
 * DQ-03: 住所登記文字列 cleanup の 3 アクションが ACTION_EXTRA_KEYS に登録され、
 * 非PIIの監査メタデータが [REDACTED] されずに残ること（監査が無価値化しない）を検証する。
 * 同時に、stray な PII キー（address/ownerName 等）は引き続き [REDACTED] されることを固定。
 */
import { describe, it, expect } from "vitest";
import { sanitizeAuditDetail, REDACTED } from "../audit-log-detail-safety";

describe("sanitizeAuditDetail: DQ-03 住所登記文字列 cleanup の allowlist", () => {
  it("preview: 非PIIキーは生存・stray address は [REDACTED]", () => {
    const out = sanitizeAuditDetail("owner_registry_address_cleanup_preview", {
      action: "cleanup",
      detectedTypes: ["receipt_number", "registration_date"],
      removableTypeCount: 2,
      auditOnlyTypeCount: 0,
      manualReviewRequired: false,
      address: "東京都港区六本木1-2-3 受付第5号",
    }) as Record<string, unknown>;
    expect(out.action).toBe("cleanup");
    expect(out.detectedTypes).toEqual(["receipt_number", "registration_date"]);
    expect(out.removableTypeCount).toBe(2);
    expect(out.auditOnlyTypeCount).toBe(0);
    expect(out.manualReviewRequired).toBe(false);
    expect(out.address).toBe(REDACTED);
  });

  it("apply: 非PIIキーは生存・stray address は [REDACTED]", () => {
    const out = sanitizeAuditDetail("owner_registry_address_cleanup_apply", {
      result: "applied",
      httpStatus: 200,
      detectedTypes: ["receipt_number"],
      removableTypeCount: 1,
      manualReviewRequired: false,
      address: "東京都港区PII住所",
    }) as Record<string, unknown>;
    expect(out.result).toBe("applied");
    expect(out.httpStatus).toBe(200);
    expect(out.detectedTypes).toEqual(["receipt_number"]);
    expect(out.removableTypeCount).toBe(1);
    expect(out.manualReviewRequired).toBe(false);
    expect(out.address).toBe(REDACTED);
  });

  it("candidates list: type/resultCount/summary(total/cleanup/manual)/hasNextPage/truncated は生存・stray は redact", () => {
    const out = sanitizeAuditDetail("owner_registry_address_candidates_list", {
      type: "all",
      resultCount: 3,
      summary: { total: 3, cleanup: 2, manual: 1 },
      hasNextPage: true,
      truncated: false,
      ownerName: "漏洩太郎",
    }) as Record<string, unknown>;
    expect(out.type).toBe("all");
    expect(out.resultCount).toBe(3);
    expect(out.summary).toEqual({ total: 3, cleanup: 2, manual: 1 });
    expect(out.hasNextPage).toBe(true);
    expect(out.truncated).toBe(false);
    expect(out.ownerName).toBe(REDACTED);
  });
});
