/**
 * audit-log-detail-safety: action "attachment_search" の登録テスト。
 *
 * 添付横断検索（GET /api/attachments/search）の非PII audit detail が、監査ログ表示側の
 * sanitize 後も auditor に有用な形で残ることを保証する。route が実際に書くキー名
 * （type / hasFileName / targetType / targetId / from / to / resultCount）に一致。
 *
 * - hasFileName は /name/i denylist に当たるため boolean force-safe で保持。
 * - targetType / from / to は action 固有 allowlist で保持（enum / ISO 日付・非PII）。
 * - type / targetId / resultCount は ALWAYS_SAFE。
 * - 検索語の生値（fileName 等）は route 側で記録しないため対象外。
 */
import { describe, it, expect } from "vitest";
import { sanitizeAuditDetail, REDACTED } from "@/lib/audit-log-detail-safety";

const detail = {
  filters: {
    type: "registry",
    hasFileName: true,
    targetType: "property",
    targetId: "11111111-1111-4111-8111-111111111111",
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-31T00:00:00.000Z",
  },
  resultCount: 3,
};

describe("sanitizeAuditDetail: attachment_search", () => {
  it("非PII detail を sanitize 後も全キー保持する", () => {
    const out = sanitizeAuditDetail("attachment_search", detail) as {
      filters: Record<string, unknown>;
      resultCount: unknown;
    };

    expect(out.filters.type).toBe("registry");
    expect(out.filters.hasFileName).toBe(true);
    expect(out.filters.targetType).toBe("property");
    expect(out.filters.targetId).toBe("11111111-1111-4111-8111-111111111111");
    expect(out.filters.from).toBe("2026-01-01T00:00:00.000Z");
    expect(out.filters.to).toBe("2026-01-31T00:00:00.000Z");
    expect(out.resultCount).toBe(3);
    expect(JSON.stringify(out)).not.toContain(REDACTED);
  });

  it("未登録 action では hasFileName/targetType/from/to は redact される（登録の効果を示す）", () => {
    const out = sanitizeAuditDetail("some_unregistered_action", detail) as {
      filters: Record<string, unknown>;
    };

    // 登録が無いと denylist / 非allowlist で redact。
    expect(out.filters.hasFileName).toBe(REDACTED);
    expect(out.filters.targetType).toBe(REDACTED);
    expect(out.filters.from).toBe(REDACTED);
    expect(out.filters.to).toBe(REDACTED);
    // type / targetId / resultCount は ALWAYS_SAFE のため未登録でも残る。
    expect(out.filters.type).toBe("registry");
    expect(out.filters.targetId).toBe("11111111-1111-4111-8111-111111111111");
  });
});
