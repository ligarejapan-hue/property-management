import { describe, it, expect } from "vitest";
import type { CorporateCandidateRowDTO } from "../api-client";
import {
  MAX_CORPORATE_BULK,
  isBulkEligible,
  eligibleOwnerIds,
  canSubmitBulk,
  buildBulkPayload,
  summarizeBulkResults,
} from "../corporate-bulk-ui";

function row(
  over: Partial<CorporateCandidateRowDTO> & {
    ownerId: string;
    type: CorporateCandidateRowDTO["type"];
  },
): CorporateCandidateRowDTO {
  return {
    ownerNameMasked: null,
    ownerAddressMasked: null,
    existingCorporateNumberMasked: null,
    candidateCorporateNumberMasked: null,
    candidateCount: 1,
    detectedIn: ["name"],
    version: 1,
    detailUrl: `/admin/owners/${over.ownerId}`,
    ...over,
  };
}

describe("corporate-bulk-ui helpers", () => {
  describe("isBulkEligible / eligibleOwnerIds", () => {
    it("missing のみ対象。conflict / multi / same は対象外", () => {
      expect(isBulkEligible({ type: "missing" })).toBe(true);
      expect(isBulkEligible({ type: "conflict" })).toBe(false);
      expect(isBulkEligible({ type: "multi" })).toBe(false);
      expect(isBulkEligible({ type: "same" })).toBe(false);
    });
    it("eligibleOwnerIds は missing 行の ownerId のみ返す", () => {
      const rows = [
        row({ ownerId: "a", type: "missing" }),
        row({ ownerId: "b", type: "conflict" }),
        row({ ownerId: "c", type: "missing" }),
        row({ ownerId: "d", type: "same" }),
      ];
      expect(eligibleOwnerIds(rows)).toEqual(["a", "c"]);
    });
  });

  describe("canSubmitBulk", () => {
    it("0 件は不可・1〜上限は可・上限超は不可", () => {
      expect(canSubmitBulk(0)).toBe(false);
      expect(canSubmitBulk(1)).toBe(true);
      expect(canSubmitBulk(MAX_CORPORATE_BULK)).toBe(true);
      expect(canSubmitBulk(MAX_CORPORATE_BULK + 1)).toBe(false);
    });
  });

  describe("buildBulkPayload", () => {
    it("eligible かつ選択済みの行だけを {ownerId, version} 化する", () => {
      const rows = [
        row({ ownerId: "a", type: "missing", version: 3 }),
        row({ ownerId: "b", type: "conflict", version: 5 }),
        row({ ownerId: "c", type: "missing", version: 7 }),
      ];
      // b は conflict（非 eligible）、c は未選択
      const payload = buildBulkPayload(rows, new Set(["a", "b"]));
      expect(payload).toEqual([{ ownerId: "a", version: 3 }]);
    });

    it("表示順を保ったまま MAX_CORPORATE_BULK で打ち切る", () => {
      const rows = Array.from({ length: MAX_CORPORATE_BULK + 5 }, (_, i) =>
        row({ ownerId: `o${i}`, type: "missing", version: i }),
      );
      const selected = new Set(rows.map((r) => r.ownerId));
      const payload = buildBulkPayload(rows, selected);
      expect(payload).toHaveLength(MAX_CORPORATE_BULK);
      expect(payload[0]).toEqual({ ownerId: "o0", version: 0 });
      expect(payload[MAX_CORPORATE_BULK - 1]).toEqual({
        ownerId: `o${MAX_CORPORATE_BULK - 1}`,
        version: MAX_CORPORATE_BULK - 1,
      });
    });
  });

  describe("summarizeBulkResults", () => {
    it("applied / skipped を数え、applied を先頭に並べる", () => {
      const summary = summarizeBulkResults([
        { status: "applied" },
        { status: "applied" },
        { status: "closed" },
        { status: "lookup_no_result" },
        { status: "version_conflict" },
      ]);
      expect(summary.applied).toBe(2);
      expect(summary.skipped).toBe(3);
      expect(summary.byStatus[0]).toEqual({ status: "applied", count: 2 });
      // 残りは件数降順→名前昇順。ここでは全て count=1 なので名前昇順
      const rest = summary.byStatus.slice(1).map((s) => s.status);
      expect(rest).toEqual(["closed", "lookup_no_result", "version_conflict"]);
    });
    it("空配列なら applied=0 / skipped=0 / byStatus=[]", () => {
      expect(summarizeBulkResults([])).toEqual({
        applied: 0,
        skipped: 0,
        byStatus: [],
      });
    });
  });
});
