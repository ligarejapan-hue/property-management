/**
 * 郵便番号 × 住所 整合チェックの純関数テスト。
 * API / DB 非依存。一致 / 不一致 / 判定不能 と CSV 行生成を網羅する。
 */
import { describe, it, expect } from "vitest";
import {
  comparePostalAddress,
  addressesLooselyMatch,
  buildPostalAuditCsvRow,
  POSTAL_AUDIT_CSV_HEADERS,
  type PostalAuditRow,
} from "../postal-code-audit";

describe("addressesLooselyMatch", () => {
  it("完全一致", () => {
    expect(addressesLooselyMatch("東京都千代田区丸の内", "東京都千代田区丸の内")).toBe(true);
  });

  it("候補が prefix（保存住所に番地が付いている）", () => {
    expect(
      addressesLooselyMatch("東京都千代田区丸の内1-1-1", "東京都千代田区丸の内"),
    ).toBe(true);
  });

  it("保存住所が候補の prefix（保存住所が町域まで）", () => {
    expect(
      addressesLooselyMatch("東京都千代田区", "東京都千代田区丸の内"),
    ).toBe(true);
  });

  it("空白の差は無視する", () => {
    expect(
      addressesLooselyMatch("東京都 千代田区 丸の内", "東京都千代田区丸の内"),
    ).toBe(true);
  });

  it("別の市区町村なら不一致", () => {
    expect(
      addressesLooselyMatch("大阪府大阪市北区梅田", "東京都千代田区丸の内"),
    ).toBe(false);
  });

  it("どちらかが空なら不一致", () => {
    expect(addressesLooselyMatch("", "東京都千代田区")).toBe(false);
    expect(addressesLooselyMatch("東京都千代田区", "   ")).toBe(false);
  });
});

describe("comparePostalAddress - match / mismatch", () => {
  it("候補のいずれかと整合すれば match", () => {
    const r = comparePostalAddress("1000005", "東京都千代田区丸の内1-1", [
      { addressLine: "東京都千代田区大手町" },
      { addressLine: "東京都千代田区丸の内" },
    ]);
    expect(r.verdict).toBe("match");
    expect(r.reason).toBeNull();
    expect(r.matchedAddressLine).toBe("東京都千代田区丸の内");
  });

  it("ハイフンあり郵便番号でも正規化して扱う", () => {
    const r = comparePostalAddress("100-0005", "東京都千代田区丸の内", [
      { addressLine: "東京都千代田区丸の内" },
    ]);
    expect(r.verdict).toBe("match");
  });

  it("どの候補とも一致しなければ mismatch（先頭候補を提示）", () => {
    const r = comparePostalAddress("1000005", "大阪府大阪市北区梅田", [
      { addressLine: "東京都千代田区丸の内" },
      { addressLine: "東京都千代田区大手町" },
    ]);
    expect(r.verdict).toBe("mismatch");
    expect(r.reason).toBeNull();
    expect(r.matchedAddressLine).toBe("東京都千代田区丸の内");
  });
});

describe("comparePostalAddress - indeterminate", () => {
  it("候補 null（照合不能）→ lookup_unavailable", () => {
    const r = comparePostalAddress("1000005", "東京都千代田区丸の内", null);
    expect(r.verdict).toBe("indeterminate");
    expect(r.reason).toBe("lookup_unavailable");
    expect(r.matchedAddressLine).toBeNull();
  });

  it("郵便番号が不正（7桁でない）→ invalid_postal_code", () => {
    const r = comparePostalAddress("123", "東京都千代田区丸の内", [
      { addressLine: "東京都千代田区丸の内" },
    ]);
    expect(r.verdict).toBe("indeterminate");
    expect(r.reason).toBe("invalid_postal_code");
  });

  it("郵便番号 null → invalid_postal_code", () => {
    const r = comparePostalAddress(null, "東京都千代田区丸の内", []);
    expect(r.reason).toBe("invalid_postal_code");
  });

  it("保存住所が空 → address_empty", () => {
    const r = comparePostalAddress("1000005", "   ", [
      { addressLine: "東京都千代田区丸の内" },
    ]);
    expect(r.verdict).toBe("indeterminate");
    expect(r.reason).toBe("address_empty");
  });

  it("候補 0 件 → no_candidate", () => {
    const r = comparePostalAddress("9999999", "東京都千代田区丸の内", []);
    expect(r.verdict).toBe("indeterminate");
    expect(r.reason).toBe("no_candidate");
  });

  it("判定順序: 照合不能 > 郵便番号不正 > 住所空 > 候補なし", () => {
    // 候補 null は郵便番号が不正でも lookup_unavailable が優先。
    expect(comparePostalAddress("xx", "", null).reason).toBe("lookup_unavailable");
    // 郵便番号不正は住所空より優先。
    expect(comparePostalAddress("xx", "", []).reason).toBe("invalid_postal_code");
  });
});

describe("buildPostalAuditCsvRow", () => {
  const base: PostalAuditRow = {
    ownerId: "o1",
    nameMasked: "山田太郎",
    zipMasked: "100-0005",
    addressMasked: "東京都千代田区丸の内1-1",
    apiAddressLine: "東京都千代田区大手町",
    verdict: "mismatch",
    reason: null,
  };

  it("ヘッダと同じ key を全て持つ", () => {
    const row = buildPostalAuditCsvRow(base);
    for (const h of POSTAL_AUDIT_CSV_HEADERS) {
      expect(row).toHaveProperty(h);
    }
  });

  it("verdict / reason を日本語ラベルにする", () => {
    expect(buildPostalAuditCsvRow(base).判定).toBe("不一致");
    const indet = buildPostalAuditCsvRow({
      ...base,
      verdict: "indeterminate",
      reason: "no_candidate",
    });
    expect(indet.判定).toBe("判定不能");
    expect(indet.理由).toBe("該当住所なし");
  });

  it("null は空文字にする", () => {
    const row = buildPostalAuditCsvRow({
      ...base,
      nameMasked: null,
      zipMasked: null,
      addressMasked: null,
      apiAddressLine: null,
      verdict: "match",
      reason: null,
    });
    expect(row.所有者名).toBe("");
    expect(row.API住所).toBe("");
    expect(row.理由).toBe("");
  });
});
