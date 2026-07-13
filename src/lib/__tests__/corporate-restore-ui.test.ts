/** corporate-restore-ui.ts(法人番号復元タブの純関数ヘルパー)のテスト。 */
import { describe, it, expect } from "vitest";
import {
  MAX_CORPORATE_RESTORE,
  isRestoreEligible,
  eligibleRestoreIds,
  canSubmitRestore,
  buildRestorePayload,
  summarizeRestoreResults,
  RESTORE_STATUS_LABEL,
  RESTORE_TYPE_LABEL,
} from "../corporate-restore-ui";
import type { CorporateRestoreRowDTO } from "../api-client";

function row(
  ownerId: string,
  eligible: boolean,
  version = 1,
): CorporateRestoreRowDTO {
  return {
    ownerId,
    type: "address_name_split",
    ownerNameMasked: null,
    ownerAddressMasked: null,
    registry12Masked: null,
    corporate13Masked: null,
    cleanedNameMasked: null,
    eligible,
    version,
    detailUrl: `/admin/owners/${ownerId}`,
  };
}

describe("eligibility / payload", () => {
  it("eligible=true のみ対象", () => {
    expect(isRestoreEligible(row("a", true))).toBe(true);
    expect(isRestoreEligible(row("b", false))).toBe(false);
    expect(eligibleRestoreIds([row("a", true), row("b", false)])).toEqual([
      "a",
    ]);
  });

  it("payload は eligible∧選択のみ・表示順・50件でcap・{ownerId,version}のみ", () => {
    const rows = [row("a", true, 3), row("b", false, 1), row("c", true, 7)];
    const payload = buildRestorePayload(rows, new Set(["a", "b", "c"]));
    expect(payload).toEqual([
      { ownerId: "a", version: 3 },
      { ownerId: "c", version: 7 },
    ]);

    const many = Array.from({ length: 60 }, (_, i) => row(`id-${i}`, true));
    const capped = buildRestorePayload(
      many,
      new Set(many.map((r) => r.ownerId)),
    );
    expect(capped).toHaveLength(MAX_CORPORATE_RESTORE);
  });

  it("canSubmitRestore は 1〜50 件のみ true", () => {
    expect(canSubmitRestore(0)).toBe(false);
    expect(canSubmitRestore(1)).toBe(true);
    expect(canSubmitRestore(50)).toBe(true);
    expect(canSubmitRestore(51)).toBe(false);
  });
});

describe("結果集計とラベル", () => {
  it("applied 先頭・残り件数降順で集計する", () => {
    const summary = summarizeRestoreResults([
      { status: "closed" },
      { status: "applied" },
      { status: "closed" },
      { status: "applied" },
      { status: "version_conflict" },
      { status: "applied" },
    ]);
    expect(summary.applied).toBe(3);
    expect(summary.skipped).toBe(3);
    expect(summary.byStatus[0]).toEqual({ status: "applied", count: 3 });
    expect(summary.byStatus[1]).toEqual({ status: "closed", count: 2 });
  });

  it("全ステータスに日本語ラベルがあり、開発用語を含まない", () => {
    for (const label of Object.values(RESTORE_STATUS_LABEL)) {
      expect(label).toMatch(/[ぁ-んァ-ヶ一-龠]/);
      expect(label).not.toMatch(/lookup|conflict|version|dry-?run/i);
    }
    for (const label of Object.values(RESTORE_TYPE_LABEL)) {
      expect(label).toMatch(/[ぁ-んァ-ヶ一-龠]/);
    }
  });
});
