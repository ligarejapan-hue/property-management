import { describe, it, expect } from "vitest";
import {
  extractAddressFromRawData,
  checkAddressFillSafety,
} from "../owner-correction";

// ── extractAddressFromRawData ──────────────────────────────────────────────

describe("extractAddressFromRawData", () => {
  it("null/undefined を渡すと null", () => {
    expect(extractAddressFromRawData(null)).toBeNull();
    expect(extractAddressFromRawData(undefined)).toBeNull();
  });

  it("空オブジェクトは null", () => {
    expect(extractAddressFromRawData({})).toBeNull();
  });

  it("「住所」キーを優先して返す", () => {
    const r = extractAddressFromRawData({ 住所: "東京都千代田区1-1", address: "other" });
    expect(r?.address).toBe("東京都千代田区1-1");
    expect(r?.sourceFieldNames).toEqual(["住所"]);
  });

  it("「所在地」キーでも取得できる", () => {
    const r = extractAddressFromRawData({ 所在地: "大阪府大阪市2-2" });
    expect(r?.address).toBe("大阪府大阪市2-2");
    expect(r?.sourceFieldNames).toEqual(["所在地"]);
  });

  it("英語キー「address」で取得できる", () => {
    const r = extractAddressFromRawData({ address: "Tokyo 1-1" });
    expect(r?.address).toBe("Tokyo 1-1");
    expect(r?.sourceFieldNames).toEqual(["address"]);
  });

  it("ownerAddress / currentAddress / 現住所 / 所有者住所 でも取得できる", () => {
    for (const key of ["ownerAddress", "currentAddress", "現住所", "所有者住所"]) {
      const r = extractAddressFromRawData({ [key]: "愛知県名古屋市1-1" });
      expect(r?.address).toBe("愛知県名古屋市1-1");
      expect(r?.sourceFieldNames).toEqual([key]);
    }
  });

  it("直接フィールドがなければ結合フィールドを使う", () => {
    const r = extractAddressFromRawData({
      都道府県: "東京都",
      所有者市区郡: "千代田区",
      所有者住所: "1-1",
      建物名: "ABCビル",
    });
    expect(r?.address).toBe("東京都千代田区1-1ABCビル");
    expect(r?.sourceFieldNames).toEqual(["都道府県", "所有者市区郡", "所有者住所", "建物名"]);
  });

  it("結合フィールドの空欄部分はスキップして結合する", () => {
    const r = extractAddressFromRawData({
      都道府県: "神奈川県",
      所有者市区郡: "横浜市",
      所有者住所: "2-3",
      建物名: "",
    });
    expect(r?.address).toBe("神奈川県横浜市2-3");
    expect(r?.sourceFieldNames).toEqual(["都道府県", "所有者市区郡", "所有者住所"]);
  });

  it("値が空文字は無効", () => {
    expect(extractAddressFromRawData({ 住所: "" })).toBeNull();
  });

  it("値が空白のみは無効", () => {
    expect(extractAddressFromRawData({ 住所: "   " })).toBeNull();
  });

  it("値が \"null\" 文字列は無効", () => {
    expect(extractAddressFromRawData({ address: "null" })).toBeNull();
  });

  it("値が \"undefined\" 文字列は無効", () => {
    expect(extractAddressFromRawData({ address: "undefined" })).toBeNull();
  });

  it("値が数値など非文字列は無効", () => {
    expect(extractAddressFromRawData({ 住所: 12345 })).toBeNull();
  });

  it("前後空白は trim される", () => {
    const r = extractAddressFromRawData({ 住所: "  東京都  " });
    expect(r?.address).toBe("東京都");
  });
});

// ── checkAddressFillSafety ─────────────────────────────────────────────────

const base = {
  currentAddress: null,
  importRowExists: true,
  importRowSuccess: true,
  addressChangeLogExists: false,
  extractedAddress: "東京都千代田区1-1",
};

describe("checkAddressFillSafety", () => {
  it("全条件を満たせば ok=true", () => {
    const r = checkAddressFillSafety(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.address).toBe("東京都千代田区1-1");
  });

  it("currentAddress が非空なら address_already_set", () => {
    expect(
      checkAddressFillSafety({ ...base, currentAddress: "既存住所" }),
    ).toEqual({ ok: false, reason: "address_already_set" });
  });

  it("currentAddress が空文字は補完対象（空文字 = null 扱い）", () => {
    const r = checkAddressFillSafety({ ...base, currentAddress: "" });
    expect(r.ok).toBe(true);
  });

  it("currentAddress が空白のみも補完対象", () => {
    const r = checkAddressFillSafety({ ...base, currentAddress: "   " });
    expect(r.ok).toBe(true);
  });

  it("importRowExists=false → import_source_unknown", () => {
    expect(
      checkAddressFillSafety({ ...base, importRowExists: false }),
    ).toEqual({ ok: false, reason: "import_source_unknown" });
  });

  it("importRowSuccess=false → import_row_not_success", () => {
    expect(
      checkAddressFillSafety({ ...base, importRowSuccess: false }),
    ).toEqual({ ok: false, reason: "import_row_not_success" });
  });

  it("addressChangeLogExists=true → address_changelog_exists", () => {
    expect(
      checkAddressFillSafety({ ...base, addressChangeLogExists: true }),
    ).toEqual({ ok: false, reason: "address_changelog_exists" });
  });

  it("extractedAddress が null → no_address_in_rawdata", () => {
    expect(
      checkAddressFillSafety({ ...base, extractedAddress: null }),
    ).toEqual({ ok: false, reason: "no_address_in_rawdata" });
  });

  it("property_owner_exists 相当の条件はブロックしない（引数に含まれない）", () => {
    // propertyOwnerCount > 0 のケースは checkAddressFillSafety の入力に影響しない。
    const r = checkAddressFillSafety(base);
    expect(r.ok).toBe(true);
  });

  it("address_already_set は import_source_unknown より優先される", () => {
    expect(
      checkAddressFillSafety({
        ...base,
        currentAddress: "既存住所",
        importRowExists: false,
      }),
    ).toEqual({ ok: false, reason: "address_already_set" });
  });
});
