/**
 * DQ-02: 郵便番号 / 電話番号 の品質判定・整形（純関数）テスト。
 *
 * 検証観点:
 * - classifyZip: 既存 isValidPostalCode 委譲（7桁）+ empty 区別。
 * - classifyPhone: 桁数(10/11)+先頭0 のみで valid 判定（局番辞書に踏み込まない誤検出回避）。
 * - normalizePhone: 全角→半角・区切り統一・ラベル剥がし。ハイフン位置は再構成しない。
 * - classifyOwnerContact / decide*Fix / checkContactFixSafety / summary。
 */
import { describe, it, expect } from "vitest";
import {
  classifyZip,
  classifyPhone,
  normalizePhone,
  phoneDigits,
  classifyOwnerContact,
  decideZipFix,
  decidePhoneFix,
  checkContactFixSafety,
  emptyOwnerContactSummary,
  tallyOwnerContact,
} from "../owner-contact-format";

describe("classifyZip", () => {
  it("7桁は valid（全角・ハイフン・前後空白を吸収）", () => {
    expect(classifyZip("1234567")).toBe("valid");
    expect(classifyZip("123-4567")).toBe("valid");
    expect(classifyZip("１２３４５６７")).toBe("valid");
    expect(classifyZip(" 123-4567 ")).toBe("valid");
  });
  it("7桁でない/非数字は suspicious", () => {
    expect(classifyZip("123")).toBe("suspicious");
    expect(classifyZip("12345678")).toBe("suspicious");
    expect(classifyZip("ABC")).toBe("suspicious");
    expect(classifyZip("〒不明")).toBe("suspicious");
  });
  it("空は empty", () => {
    expect(classifyZip("")).toBe("empty");
    expect(classifyZip("   ")).toBe("empty");
    expect(classifyZip(null)).toBe("empty");
    expect(classifyZip(undefined)).toBe("empty");
  });
});

describe("phoneDigits / normalizePhone", () => {
  it("phoneDigits は全角含む数字だけ抽出", () => {
    expect(phoneDigits("03-1234-5678")).toBe("0312345678");
    expect(phoneDigits("０９０（１２３４）５６７８")).toBe("09012345678");
    expect(phoneDigits("不明")).toBe("");
  });
  it("normalizePhone は区切りを - 統一・ラベル剥がし（位置は再構成しない）", () => {
    expect(normalizePhone("０３（１２３４）５６７８")).toBe("03-1234-5678");
    expect(normalizePhone("TEL:03-1234-5678")).toBe("03-1234-5678");
    expect(normalizePhone("電話 090 1234 5678")).toBe("090-1234-5678");
    expect(normalizePhone("0312345678")).toBe("0312345678"); // 区切り無しは追加しない
    expect(normalizePhone("")).toBe("");
  });
});

describe("classifyPhone — valid（桁数+先頭0）", () => {
  it("固定10桁/携帯11桁/IP/フリーダイヤルは valid", () => {
    expect(classifyPhone("03-1234-5678")).toBe("valid"); // 10
    expect(classifyPhone("090-1234-5678")).toBe("valid"); // 11
    expect(classifyPhone("050-1234-5678")).toBe("valid"); // 11 IP
    expect(classifyPhone("0120-123-456")).toBe("valid"); // 10 freedial
    expect(classifyPhone("０９０１２３４５６７８")).toBe("valid"); // 全角11
    expect(classifyPhone("電話03-1234-5678")).toBe("valid"); // ラベル付きでも数字は valid
  });
});

describe("classifyPhone — suspicious / non_phone / empty（誤検出回避）", () => {
  it("桁範囲外/先頭0でないは suspicious", () => {
    expect(classifyPhone("12345")).toBe("suspicious"); // 5桁
    expect(classifyPhone("1234567890")).toBe("suspicious"); // 10桁だが先頭0でない
    expect(classifyPhone("0312345678内線99")).toBe("suspicious"); // 12桁(内線)
    expect(classifyPhone("+81-90-1234-5678")).toBe("suspicious"); // 国番号は0置換しない→13桁
  });
  it("数字0桁は non_phone", () => {
    expect(classifyPhone("不明")).toBe("non_phone");
    expect(classifyPhone("電話なし")).toBe("non_phone");
    expect(classifyPhone("---")).toBe("non_phone");
  });
  it("空は empty", () => {
    expect(classifyPhone("")).toBe("empty");
    expect(classifyPhone("  ")).toBe("empty");
    expect(classifyPhone(null)).toBe("empty");
  });
});

describe("classifyOwnerContact", () => {
  it("suspicious zip は warning", () => {
    const r = classifyOwnerContact({ zip: "123", phone: "090-1234-5678" });
    expect(r.issues).toContain("zip_suspicious");
    expect(r.severity).toBe("warning");
  });
  it("valid だが未整形 zip は info(zip_unformatted)", () => {
    const r = classifyOwnerContact({ zip: "1234567", phone: null });
    expect(r.issues).toContain("zip_unformatted");
    expect(r.severity).toBe("info");
  });
  it("整形済み valid zip は issue なし", () => {
    const r = classifyOwnerContact({ zip: "123-4567", phone: null });
    expect(r.issues).toHaveLength(0);
    expect(r.severity).toBeNull();
  });
  it("phone non_phone は warning", () => {
    const r = classifyOwnerContact({ zip: null, phone: "不明" });
    expect(r.issues).toContain("phone_non_phone");
    expect(r.severity).toBe("warning");
  });
  it("valid だが未正規化 phone は info(phone_unnormalized)", () => {
    const r = classifyOwnerContact({ zip: null, phone: "０９０（１２３４）５６７８" });
    expect(r.issues).toContain("phone_unnormalized");
    expect(r.severity).toBe("info");
  });
  it("空は issue なし（empty は欠損であり形式エラーではない）", () => {
    const r = classifyOwnerContact({ zip: "", phone: null });
    expect(r.issues).toHaveLength(0);
  });

  describe("フィールド可視性ゲート（DQ-02 P1）", () => {
    it("zip 不可視のとき zip 由来の issue を出さない", () => {
      const r = classifyOwnerContact(
        { zip: "123", phone: "不明" },
        { zip: false, phone: true },
      );
      expect(r.issues).not.toContain("zip_suspicious");
      expect(r.issues).toContain("phone_non_phone");
    });
    it("phone 不可視のとき phone 由来の issue を出さない", () => {
      const r = classifyOwnerContact(
        { zip: "123", phone: "不明" },
        { zip: true, phone: false },
      );
      expect(r.issues).toContain("zip_suspicious");
      expect(r.issues).not.toContain("phone_non_phone");
      expect(r.issues).not.toContain("phone_unnormalized");
    });
    it("両方不可視なら issue なし・severity null", () => {
      const r = classifyOwnerContact(
        { zip: "123", phone: "不明" },
        { zip: false, phone: false },
      );
      expect(r.issues).toHaveLength(0);
      expect(r.severity).toBeNull();
    });
    it("visibility 未指定は従来どおり両方分類（後方互換）", () => {
      const r = classifyOwnerContact({ zip: "123", phone: "不明" });
      expect(r.issues).toContain("zip_suspicious");
      expect(r.issues).toContain("phone_non_phone");
    });
  });
});

describe("decideZipFix / decidePhoneFix", () => {
  it("valid 未整形 zip は format で 123-4567 へ", () => {
    const p = decideZipFix("1234567");
    expect(p.action).toBe("format");
    expect(p.cleanedValue).toBe("123-4567");
    expect(p.changedFields).toEqual(["zip"]);
  });
  it("整形済み zip は none", () => {
    expect(decideZipFix("123-4567").action).toBe("none");
  });
  it("suspicious zip は manual/suspicious（自動整形しない）", () => {
    const p = decideZipFix("123");
    expect(p.action).toBe("manual");
    expect(p.manualReason).toBe("suspicious");
    expect(p.cleanedValue).toBeNull();
  });
  it("empty zip は manual/empty", () => {
    expect(decideZipFix("").manualReason).toBe("empty");
  });
  it("valid 未正規化 phone は format", () => {
    const p = decidePhoneFix("０９０（１２３４）５６７８");
    expect(p.action).toBe("format");
    expect(p.cleanedValue).toBe("090-1234-5678");
    expect(p.changedFields).toEqual(["phone"]);
  });
  it("non_phone は manual/non_phone", () => {
    expect(decidePhoneFix("不明").manualReason).toBe("non_phone");
  });
  it("suspicious phone は manual/suspicious", () => {
    expect(decidePhoneFix("12345").manualReason).toBe("suspicious");
  });
});

describe("checkContactFixSafety", () => {
  const base = {
    field: "zip" as const,
    isArchived: false,
    versionMatches: true,
    currentValue: "123",
    newValue: "123-4567",
  };
  it("正常な set は ok", () => {
    expect(checkContactFixSafety(base).ok).toBe(true);
  });
  it("archived はブロック", () => {
    const r = checkContactFixSafety({ ...base, isArchived: true });
    if (!r.ok) expect(r.reasons).toContain("owner_archived");
  });
  it("version 不一致はブロック", () => {
    const r = checkContactFixSafety({ ...base, versionMatches: false });
    if (!r.ok) expect(r.reasons).toContain("version_mismatch");
  });
  it("無変更は no_change（null と空文字は同一視）", () => {
    const r = checkContactFixSafety({ ...base, currentValue: "", newValue: null });
    if (!r.ok) expect(r.reasons).toContain("no_change");
  });
  it("新 zip が無効なら forbidden_value", () => {
    const r = checkContactFixSafety({ ...base, newValue: "999" });
    if (!r.ok) expect(r.reasons).toContain("forbidden_value");
  });
  it("新 phone が無効なら forbidden_value", () => {
    const r = checkContactFixSafety({
      field: "phone",
      isArchived: false,
      versionMatches: true,
      currentValue: "不明",
      newValue: "12345",
    });
    if (!r.ok) expect(r.reasons).toContain("forbidden_value");
  });
  it("空へのクリア（ゴミ削除）は許可", () => {
    const r = checkContactFixSafety({
      field: "phone",
      isArchived: false,
      versionMatches: true,
      currentValue: "不明",
      newValue: "",
    });
    expect(r.ok).toBe(true);
  });
});

describe("summary helper", () => {
  it("issue 種別ごとに集計", () => {
    const s = emptyOwnerContactSummary();
    tallyOwnerContact(s, classifyOwnerContact({ zip: "123", phone: null }));
    tallyOwnerContact(s, classifyOwnerContact({ zip: null, phone: "不明" }));
    tallyOwnerContact(s, classifyOwnerContact({ zip: "1234567", phone: null }));
    tallyOwnerContact(s, classifyOwnerContact({ zip: "123-4567", phone: "090-1234-5678" }));
    expect(s.zipSuspicious).toBe(1);
    expect(s.phoneNonPhone).toBe(1);
    expect(s.zipUnformatted).toBe(1);
    expect(s.totalCandidates).toBe(3);
  });
});
