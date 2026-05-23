/**
 * Phase E: 法人番号 dry-run 候補分類ヘルパーの単体テスト。
 *
 * 検証観点:
 * - 候補 0 件 → null（呼び出し側で除外）
 * - 候補 1 件 + existing=null → missing
 * - 候補 1 件 + existing 同一 → same
 * - 候補 1 件 + existing 異なる → conflict
 * - 候補 2 件以上 → multi
 * - detectedIn が name/address/note を正しく返す
 * - display-level に応じてマスキングが効く（full / masked / hidden）
 */
import { describe, it, expect } from "vitest";
import {
  classifyOwnerCorporateCandidate,
  emptyCorporateCandidateSummary,
  tallyCorporateCandidate,
  type CandidateDisplayConfig,
  type OwnerForCandidate,
} from "../owner-corporate-candidates";

const CN = "1234567890123";
const CN_OTHER = "9876543210123";

const FULL: CandidateDisplayConfig = {
  name: "full",
  address: "full",
  corporateNumber: "full",
};

const MASKED: CandidateDisplayConfig = {
  name: "masked",
  address: "masked",
  corporateNumber: "masked",
};

const HIDDEN: CandidateDisplayConfig = {
  name: "hidden",
  address: "hidden",
  corporateNumber: "hidden",
};

function owner(o: Partial<OwnerForCandidate>): OwnerForCandidate {
  return {
    id: o.id ?? "o-1",
    name: o.name ?? "山田太郎",
    address: o.address ?? null,
    note: o.note ?? null,
    corporateNumber: o.corporateNumber ?? null,
    version: o.version ?? 1,
  };
}

describe("classifyOwnerCorporateCandidate", () => {
  it("候補 0 件 → null", () => {
    const result = classifyOwnerCorporateCandidate(
      owner({ name: "山田太郎", address: "東京都千代田区" }),
      FULL,
    );
    expect(result).toBeNull();
  });

  it("候補 1 件 + existing null → missing", () => {
    const result = classifyOwnerCorporateCandidate(
      owner({ name: `○○株式会社 法人番号:${CN}`, corporateNumber: null }),
      FULL,
    );
    expect(result?.type).toBe("missing");
    expect(result?.candidateCount).toBe(1);
    expect(result?.existingCorporateNumberMasked).toBeNull();
    expect(result?.candidateCorporateNumberMasked).toBe(CN);
  });

  it("候補 1 件 + existing 同一 → same", () => {
    const result = classifyOwnerCorporateCandidate(
      owner({ name: `○○株式会社 ${CN}`, corporateNumber: CN }),
      FULL,
    );
    expect(result?.type).toBe("same");
    expect(result?.candidateCount).toBe(1);
    expect(result?.existingCorporateNumberMasked).toBe(CN);
    expect(result?.candidateCorporateNumberMasked).toBe(CN);
  });

  it("候補 1 件 + existing 異なる → conflict", () => {
    const result = classifyOwnerCorporateCandidate(
      owner({ name: `○○株式会社 ${CN}`, corporateNumber: CN_OTHER }),
      FULL,
    );
    expect(result?.type).toBe("conflict");
    expect(result?.candidateCount).toBe(1);
    expect(result?.existingCorporateNumberMasked).toBe(CN_OTHER);
    expect(result?.candidateCorporateNumberMasked).toBe(CN);
  });

  it("候補複数 → multi（candidateCorporateNumberMasked は null）", () => {
    const result = classifyOwnerCorporateCandidate(
      owner({
        name: `A社 法人番号:${CN}`,
        note: `B社 ${CN_OTHER}`,
      }),
      FULL,
    );
    expect(result?.type).toBe("multi");
    expect(result?.candidateCount).toBe("many");
    expect(result?.candidateCorporateNumberMasked).toBeNull();
  });

  it("detectedIn が name/address/note を正しく返す", () => {
    const result = classifyOwnerCorporateCandidate(
      owner({
        name: "山田太郎",
        address: `東京都千代田区 法人番号:${CN}`,
      }),
      FULL,
    );
    expect(result?.detectedIn).toEqual(["address"]);
  });

  it("detectedIn は note も拾う", () => {
    const result = classifyOwnerCorporateCandidate(
      owner({ name: "山田太郎", note: `法人番号:${CN}` }),
      FULL,
    );
    expect(result?.detectedIn).toEqual(["note"]);
  });

  it("detailUrl が /admin/owners/{id}", () => {
    const result = classifyOwnerCorporateCandidate(
      owner({ id: "abc-123", name: `株式会社 ${CN}` }),
      FULL,
    );
    expect(result?.detailUrl).toBe("/admin/owners/abc-123");
  });
});

describe("classifyOwnerCorporateCandidate — display-level マスキング", () => {
  // 事前確定方針: full のみ生値、edit/read/masked/partial はマスク、hidden は null。

  it("full → 法人番号は生値で返る", () => {
    const result = classifyOwnerCorporateCandidate(
      owner({ name: `株式会社 ${CN}`, corporateNumber: CN_OTHER }),
      FULL,
    );
    expect(result?.candidateCorporateNumberMasked).toBe(CN);
    expect(result?.existingCorporateNumberMasked).toBe(CN_OTHER);
  });

  it("edit → 法人番号はマスクされる（事前確定方針）", () => {
    const result = classifyOwnerCorporateCandidate(
      owner({ name: `株式会社 ${CN}`, corporateNumber: CN_OTHER }),
      { ...FULL, corporateNumber: "edit" },
    );
    expect(result?.candidateCorporateNumberMasked).not.toBe(CN);
    expect(result?.candidateCorporateNumberMasked).toMatch(/^\d{4}\*+$/);
    expect(result?.existingCorporateNumberMasked).not.toBe(CN_OTHER);
    expect(result?.existingCorporateNumberMasked).toMatch(/^\d{4}\*+$/);
  });

  it("read → 法人番号はマスクされる（事前確定方針）", () => {
    const result = classifyOwnerCorporateCandidate(
      owner({ name: `株式会社 ${CN}`, corporateNumber: CN_OTHER }),
      { ...FULL, corporateNumber: "read" },
    );
    expect(result?.candidateCorporateNumberMasked).not.toBe(CN);
    expect(result?.candidateCorporateNumberMasked).toMatch(/^\d{4}\*+$/);
    expect(result?.existingCorporateNumberMasked).not.toBe(CN_OTHER);
    expect(result?.existingCorporateNumberMasked).toMatch(/^\d{4}\*+$/);
  });

  it("masked → 法人番号は先頭4桁マスク（生 13桁は出ない）", () => {
    const result = classifyOwnerCorporateCandidate(
      owner({ name: `株式会社 ${CN}`, corporateNumber: CN_OTHER }),
      MASKED,
    );
    // maskCorporateNumber は "1234*********" 形式
    expect(result?.candidateCorporateNumberMasked).toMatch(/^\d{4}\*+$/);
    expect(result?.existingCorporateNumberMasked).toMatch(/^\d{4}\*+$/);
    // 生 13桁が出ていないこと
    expect(result?.candidateCorporateNumberMasked).not.toBe(CN);
    expect(result?.existingCorporateNumberMasked).not.toBe(CN_OTHER);
  });

  it("partial → 法人番号はマスクされる（事前確定方針）", () => {
    const result = classifyOwnerCorporateCandidate(
      owner({ name: `株式会社 ${CN}`, corporateNumber: CN_OTHER }),
      { ...FULL, corporateNumber: "partial" },
    );
    expect(result?.candidateCorporateNumberMasked).not.toBe(CN);
    expect(result?.candidateCorporateNumberMasked).toMatch(/^\d{4}\*+$/);
    expect(result?.existingCorporateNumberMasked).not.toBe(CN_OTHER);
    expect(result?.existingCorporateNumberMasked).toMatch(/^\d{4}\*+$/);
  });

  it("hidden → 法人番号フィールドは null", () => {
    const result = classifyOwnerCorporateCandidate(
      owner({ name: `株式会社 ${CN}`, corporateNumber: CN_OTHER }),
      HIDDEN,
    );
    expect(result?.candidateCorporateNumberMasked).toBeNull();
    expect(result?.existingCorporateNumberMasked).toBeNull();
  });

  it("name/address も display-level に従いマスクされる", () => {
    const result = classifyOwnerCorporateCandidate(
      owner({
        name: `株式会社 法人番号:${CN}`,
        address: "東京都千代田区丸の内1-1-1",
      }),
      MASKED,
    );
    // maskValue(value, "masked") は末尾4桁残し → "***" + last4
    expect(result?.ownerNameMasked).toMatch(/^\*+/);
    expect(result?.ownerAddressMasked).toMatch(/^\*+/);
  });

  it("hidden → name/address も null", () => {
    const result = classifyOwnerCorporateCandidate(
      owner({
        name: `株式会社 ${CN}`,
        address: "東京都千代田区",
      }),
      HIDDEN,
    );
    expect(result?.ownerNameMasked).toBeNull();
    expect(result?.ownerAddressMasked).toBeNull();
  });
});

describe("summary 集計", () => {
  it("各 type を加算し totalCandidates を集計", () => {
    const s = emptyCorporateCandidateSummary();
    tallyCorporateCandidate(s, "missing");
    tallyCorporateCandidate(s, "missing");
    tallyCorporateCandidate(s, "conflict");
    tallyCorporateCandidate(s, "multi");
    tallyCorporateCandidate(s, "same");
    expect(s).toEqual({
      missing: 2,
      conflict: 1,
      multi: 1,
      same: 1,
      totalCandidates: 5,
    });
  });
});
