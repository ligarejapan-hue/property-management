import { describe, it, expect } from "vitest";
import { sanitizeAuditDetail } from "@/lib/audit-log-detail-safety";

/**
 * 外部AI方式で増える監査 action の detail が、**表示時に消えない**ことを固定する。
 *
 * ⚠監査に残すには2段そろっている必要がある（PR-D1 で実際に踏んだ）:
 *   ①route が detail に書く ②audit-log-detail-safety の allowlist に載っている
 * ①だけだと記録はされるのに監査画面では [REDACTED] になり、気づけない。
 */
const CASES: Array<{ action: string; detail: Record<string, unknown> }> = [
  {
    action: "sale_dm_prompt_view",
    detail: { campaignId: "c1", viewedAt: "2026-08-14T00:00:00.000Z" },
  },
  {
    action: "sale_dm_body_paste",
    detail: { campaignId: "c1", pastedAt: "2026-08-14T00:00:00.000Z" },
  },
  {
    action: "sale_dm_template_apply",
    detail: {
      campaignId: "c1",
      appliedCount: 3,
      skippedScopeCount: 1,
      skippedTagCount: 2,
      appliedAt: "2026-08-14T00:00:00.000Z",
    },
  },
];

describe("外部AI方式の監査 detail は表示でも消えない", () => {
  for (const { action, detail } of CASES) {
    it(`${action}: 全キーが sanitize を通る`, () => {
      const out = sanitizeAuditDetail(action, detail) as Record<string, unknown>;
      const redacted = Object.keys(detail).filter(
        (k) => out[k] !== detail[k],
      );
      expect(redacted).toEqual([]);
    });
  }

  it("本文・プロンプトのような自由文は載せても消える(誤って入れた時の保険)", () => {
    const out = sanitizeAuditDetail("sale_dm_body_paste", {
      campaignId: "c1",
      body: "拝啓 これは本文です",
    }) as Record<string, unknown>;
    expect(out.body).not.toBe("拝啓 これは本文です");
  });
});
