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
    detail: {
      campaignId: "c1",
      clearedCount: 2,
      pastedAt: "2026-08-14T00:00:00.000Z",
    },
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
  { action: "sale_dm_lp_prompt_view", detail: { campaignId: "c1", viewedAt: "2026-09-09T00:00:00.000Z" } },
  { action: "sale_dm_lp_body_paste", detail: { campaignId: "c1", faqCount: 3, bodyLength: 120, pastedAt: "2026-09-09T00:00:00.000Z" } },
  // LP型削除は割当なしへ戻した件数(detachedCount)も残す(@codex R5 finding)。
  { action: "sale_dm_lp_variant_delete", detail: { campaignId: "c1", detachedCount: 2, deletedAt: "2026-09-09T00:00:00.000Z" } },
  { action: "sale_dm_lp_asset_upload", detail: { bytes: 1234, width: 1600, height: 900, uploadedAt: "2026-09-10T00:00:00.000Z" } },
  { action: "sale_dm_lp_media_update", detail: { campaignId: "c1", assetCount: 2, figureCount: 1, updatedAt: "2026-09-10T00:00:00.000Z" } },
  { action: "sale_dm_lp_image_prompt_view", detail: { campaignId: "c1", slot: "hero", viewedAt: "2026-09-10T00:00:00.000Z" } },
  { action: "sale_dm_lp_asset_delete", detail: { deletedAt: "2026-09-10T00:00:00.000Z" } },
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
