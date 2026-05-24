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
  note: "full",
};

// MASKED: corporateNumber のみ masked、name/address/note は raw-visible に保つ
// （raw-visible でないと検出自体が走らないため、corporateNumber マスキング検証ができない）。
// name/address/note 自身の raw-visible ガードは別 describe で扱う。
const MASKED: CandidateDisplayConfig = {
  name: "full",
  address: "full",
  corporateNumber: "masked",
  note: "full",
};

// HIDDEN: corporateNumber のみ hidden、それ以外の確認用は別途
const HIDDEN: CandidateDisplayConfig = {
  name: "full",
  address: "full",
  corporateNumber: "hidden",
  note: "full",
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
    // note (raw-visible=full) で検出を駆動し、name/address は masked で表示マスク確認
    const result = classifyOwnerCorporateCandidate(
      owner({
        name: "株式会社サンプル",
        address: "東京都千代田区丸の内1-1-1",
        note: `法人番号:${CN}`,
      }),
      { ...FULL, name: "masked", address: "masked" },
    );
    // maskValue(value, "masked") は末尾4桁残し → "***" + last4
    expect(result?.ownerNameMasked).toMatch(/^\*+/);
    expect(result?.ownerAddressMasked).toMatch(/^\*+/);
  });

  it("hidden → name/address も null", () => {
    const result = classifyOwnerCorporateCandidate(
      owner({
        name: "株式会社サンプル",
        address: "東京都千代田区",
        note: `法人番号:${CN}`,
      }),
      { ...FULL, name: "hidden", address: "hidden" },
    );
    expect(result?.ownerNameMasked).toBeNull();
    expect(result?.ownerAddressMasked).toBeNull();
  });
});

// ---- Codex 再修正 P2: name/address にも raw-visible ガード ----
describe("classifyOwnerCorporateCandidate — Codex P2: owner_name/address 権限", () => {
  it("owner_name=hidden で name のみに法人番号がある owner は候補化しない", () => {
    const result = classifyOwnerCorporateCandidate(
      owner({ name: `株式会社 法人番号:${CN}`, address: null, note: null }),
      { ...FULL, name: "hidden" },
    );
    expect(result).toBeNull();
  });

  it("owner_name=masked で name のみに法人番号がある owner は候補化しない", () => {
    const result = classifyOwnerCorporateCandidate(
      owner({ name: `株式会社 ${CN}`, address: null, note: null }),
      { ...FULL, name: "masked" },
    );
    expect(result).toBeNull();
  });

  it("owner_name=partial で name のみに法人番号がある owner は候補化しない", () => {
    const result = classifyOwnerCorporateCandidate(
      owner({ name: `株式会社 ${CN}` }),
      { ...FULL, name: "partial" },
    );
    expect(result).toBeNull();
  });

  it("owner_name=read で name のみに法人番号がある owner は候補化される", () => {
    const result = classifyOwnerCorporateCandidate(
      owner({ name: `株式会社 ${CN}` }),
      { ...FULL, name: "read" },
    );
    expect(result?.type).toBe("missing");
    expect(result?.detectedIn).toEqual(["name"]);
  });

  it("owner_address=hidden で address のみに法人番号がある owner は候補化しない", () => {
    const result = classifyOwnerCorporateCandidate(
      owner({
        name: "山田太郎",
        address: `東京都 法人番号:${CN}`,
        note: null,
      }),
      { ...FULL, address: "hidden" },
    );
    expect(result).toBeNull();
  });

  it("owner_address=masked で address のみに法人番号がある owner は候補化しない", () => {
    const result = classifyOwnerCorporateCandidate(
      owner({
        name: "山田太郎",
        address: `東京都 ${CN}`,
        note: null,
      }),
      { ...FULL, address: "masked" },
    );
    expect(result).toBeNull();
  });

  it("owner_address=partial で address のみに法人番号がある owner は候補化しない", () => {
    const result = classifyOwnerCorporateCandidate(
      owner({
        name: "山田太郎",
        address: `東京都 ${CN}`,
        note: null,
      }),
      { ...FULL, address: "partial" },
    );
    expect(result).toBeNull();
  });

  it("owner_address=hidden でも note に法人番号があれば候補化、detectedIn から address を除外", () => {
    const result = classifyOwnerCorporateCandidate(
      owner({
        name: "山田太郎",
        address: `東京都 ${CN_OTHER}`,
        note: `法人番号:${CN}`,
      }),
      { ...FULL, address: "hidden" },
    );
    expect(result?.type).toBe("missing");
    expect(result?.detectedIn).toEqual(["note"]);
    expect(result?.detectedIn).not.toContain("address");
  });

  it("複数フィールド非 raw-visible でも raw-visible なフィールドに候補があれば候補化", () => {
    const result = classifyOwnerCorporateCandidate(
      owner({
        name: `株式会社 ${CN}`,
        address: `東京都 ${CN_OTHER}`,
        note: `note ${CN_OTHER}`,
      }),
      { ...FULL, address: "masked", note: "hidden" },
    );
    // name から CN のみ検出される
    expect(result?.type).toBe("missing");
    expect(result?.detectedIn).toEqual(["name"]);
  });
});

// ---- Codex P1: note 検出の field-level permission ガード ----
describe("classifyOwnerCorporateCandidate — Codex P1: owner_note 権限", () => {
  it("owner_note=hidden で note のみに法人番号がある owner は候補化しない", () => {
    const result = classifyOwnerCorporateCandidate(
      owner({ name: "山田太郎", note: `法人番号:${CN}` }),
      { ...FULL, note: "hidden" },
    );
    expect(result).toBeNull();
  });

  it("owner_note=masked で note のみに法人番号がある owner は候補化しない", () => {
    const result = classifyOwnerCorporateCandidate(
      owner({ name: "山田太郎", note: `法人番号:${CN}` }),
      { ...FULL, note: "masked" },
    );
    expect(result).toBeNull();
  });

  it("owner_note=partial で note のみに法人番号がある owner は候補化しない", () => {
    const result = classifyOwnerCorporateCandidate(
      owner({ name: "山田太郎", note: `法人番号:${CN}` }),
      { ...FULL, note: "partial" },
    );
    expect(result).toBeNull();
  });

  it("owner_note=full で note のみに法人番号がある owner は missing 候補化", () => {
    const result = classifyOwnerCorporateCandidate(
      owner({ name: "山田太郎", note: `法人番号:${CN}` }),
      { ...FULL, note: "full" },
    );
    expect(result?.type).toBe("missing");
    expect(result?.detectedIn).toEqual(["note"]);
  });

  it("owner_note=read で note のみに法人番号がある owner は候補化される（raw-visible）", () => {
    const result = classifyOwnerCorporateCandidate(
      owner({ name: "山田太郎", note: `法人番号:${CN}` }),
      { ...FULL, note: "read" },
    );
    expect(result?.type).toBe("missing");
    expect(result?.detectedIn).toEqual(["note"]);
  });

  it("owner_note=edit で note のみに法人番号がある owner は候補化される（raw-visible）", () => {
    const result = classifyOwnerCorporateCandidate(
      owner({ name: "山田太郎", note: `法人番号:${CN}` }),
      { ...FULL, note: "edit" },
    );
    expect(result?.type).toBe("missing");
    expect(result?.detectedIn).toEqual(["note"]);
  });

  it("owner_note=hidden でも name に法人番号があれば候補化、detectedIn に note を含めない", () => {
    const result = classifyOwnerCorporateCandidate(
      owner({ name: `株式会社 法人番号:${CN}`, note: `別の番号 ${CN_OTHER}` }),
      { ...FULL, note: "hidden" },
    );
    expect(result?.type).toBe("missing");
    expect(result?.detectedIn).toEqual(["name"]);
    expect(result?.detectedIn).not.toContain("note");
  });

  it("owner_note=hidden で hidden note のせいで multi にならない（bypass 防止）", () => {
    // name に CN、hidden note に CN_OTHER。owner_note=full なら multi だが、
    // hidden note を検出から除外するため missing に分類される。
    const result = classifyOwnerCorporateCandidate(
      owner({ name: `株式会社 ${CN}`, note: `別法人 ${CN_OTHER}` }),
      { ...FULL, note: "hidden" },
    );
    expect(result?.type).toBe("missing");
    expect(result?.detectedIn).toEqual(["name"]);
  });

  it("owner_note=hidden で hidden note のせいで conflict にならない", () => {
    // existing corporateNumber が CN、name に CN、hidden note に CN_OTHER。
    // hidden note を入れたら multi になり「複数候補のため上書きせず conflict 化」しかねない。
    // → hidden note を除外することで same に分類される。
    const result = classifyOwnerCorporateCandidate(
      owner({
        name: `株式会社 ${CN}`,
        note: `別法人 ${CN_OTHER}`,
        corporateNumber: CN,
      }),
      { ...FULL, note: "hidden" },
    );
    expect(result?.type).toBe("same");
    expect(result?.detectedIn).toEqual(["name"]);
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
