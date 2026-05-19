import { describe, it, expect } from "vitest";
import {
  extractAddressFromRawData,
  checkAddressFillSafety,
  resolveReceptionOwnerEntry,
  extractAddressFromRecoveredOwner,
  checkOwnerArchiveSafety,
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
  importRowCount: 1,
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

  it("importRowCount=0 → import_source_unknown", () => {
    expect(
      checkAddressFillSafety({ ...base, importRowCount: 0 }),
    ).toEqual({ ok: false, reason: "import_source_unknown" });
  });

  it("importRowCount=2 → import_source_ambiguous", () => {
    expect(
      checkAddressFillSafety({ ...base, importRowCount: 2 }),
    ).toEqual({ ok: false, reason: "import_source_ambiguous" });
  });

  it("importRowCount=2 かつ importRowSuccess=true でも import_source_ambiguous（複数件から選ばない）", () => {
    expect(
      checkAddressFillSafety({ ...base, importRowCount: 2, importRowSuccess: true }),
    ).toEqual({ ok: false, reason: "import_source_ambiguous" });
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
        importRowCount: 0,
      }),
    ).toEqual({ ok: false, reason: "address_already_set" });
  });

  it("receptionOwnerEntryAmbiguous=true → reception_owner_source_ambiguous", () => {
    expect(
      checkAddressFillSafety({ ...base, receptionOwnerEntryAmbiguous: true }),
    ).toEqual({ ok: false, reason: "reception_owner_source_ambiguous" });
  });

  it("address_already_set は receptionOwnerEntryAmbiguous より優先される", () => {
    expect(
      checkAddressFillSafety({
        ...base,
        currentAddress: "既存住所",
        receptionOwnerEntryAmbiguous: true,
      }),
    ).toEqual({ ok: false, reason: "address_already_set" });
  });
});

// ── resolveReceptionOwnerEntry ────────────────────────────────────────────

describe("resolveReceptionOwnerEntry", () => {
  const entry1 = { name: "田中太郎", address: "東京都千代田区1-1", zip: "1000001" };
  const entry2 = { name: "佐藤花子", address: "大阪府大阪市1-1", zip: "5300001" };

  it("名前が一致する entry が 1件 → ok=true で entry を返す", () => {
    const r = resolveReceptionOwnerEntry([entry1, entry2], "田中太郎", null);
    expect(r).toEqual({ ok: true, entry: entry1 });
  });

  it("全角/半角スペース混在の名前も正規化して一致する", () => {
    const r = resolveReceptionOwnerEntry(
      [{ name: "田中　太郎", address: "東京都千代田区1-1", zip: null }],
      "田中 太郎",
      null,
    );
    expect(r).toEqual({ ok: true, entry: { name: "田中　太郎", address: "東京都千代田区1-1", zip: null } });
  });

  it("名前一致 0件 → no_address_in_rawdata", () => {
    const r = resolveReceptionOwnerEntry([entry2], "田中太郎", null);
    expect(r).toEqual({ ok: false, reason: "no_address_in_rawdata" });
  });

  it("ownerName が null → no_address_in_rawdata", () => {
    const r = resolveReceptionOwnerEntry([entry1], null, null);
    expect(r).toEqual({ ok: false, reason: "no_address_in_rawdata" });
  });

  it("名前一致が複数で zip なし → reception_owner_source_ambiguous", () => {
    const dup = { name: "田中太郎", address: "神奈川県横浜市2-2", zip: null };
    const r = resolveReceptionOwnerEntry([entry1, dup], "田中太郎", null);
    expect(r).toEqual({ ok: false, reason: "reception_owner_source_ambiguous" });
  });

  it("名前一致が複数で zip で絞り込み成功 → ok=true", () => {
    const dup = { name: "田中太郎", address: "神奈川県横浜市2-2", zip: "2200001" };
    const r = resolveReceptionOwnerEntry([entry1, dup], "田中太郎", "1000001");
    expect(r).toEqual({ ok: true, entry: entry1 });
  });

  it("名前一致が複数で zip でも絞り込めない → reception_owner_source_ambiguous", () => {
    const dup = { name: "田中太郎", address: "神奈川県横浜市2-2", zip: "1000001" };
    const r = resolveReceptionOwnerEntry([entry1, dup], "田中太郎", "1000001");
    expect(r).toEqual({ ok: false, reason: "reception_owner_source_ambiguous" });
  });

  it("名前一致 1件で address が null → no_address_in_rawdata", () => {
    const r = resolveReceptionOwnerEntry(
      [{ name: "田中太郎", address: null, zip: null }],
      "田中太郎",
      null,
    );
    expect(r).toEqual({ ok: false, reason: "no_address_in_rawdata" });
  });

  it("別ownerの address は使わない（佐藤花子の住所を田中太郎に割り当てない）", () => {
    const r = resolveReceptionOwnerEntry([entry1, entry2], "田中太郎", null);
    if (r.ok) {
      expect(r.entry.address).toBe("東京都千代田区1-1");
      expect(r.entry.address).not.toBe("大阪府大阪市1-1");
    }
  });
});

// ── extractAddressFromRecoveredOwner ──────────────────────────────────────

describe("extractAddressFromRecoveredOwner", () => {
  it("address が有効 → ExtractAddressResult を返す", () => {
    const r = extractAddressFromRecoveredOwner({
      name: "田中太郎",
      address: "東京都千代田区1-1",
      zip: null,
    });
    expect(r?.address).toBe("東京都千代田区1-1");
    // sourceFieldNames には値を含まないフィールドパス名のみ
    expect(r?.sourceFieldNames).toEqual(["__owner_link_data.address"]);
    expect(r?.sourceFieldNames.join("")).not.toContain("東京都");
  });

  it("address が null → null", () => {
    const r = extractAddressFromRecoveredOwner({
      name: "田中太郎",
      address: null,
      zip: null,
    });
    expect(r).toBeNull();
  });

  it("address が空文字 → null", () => {
    const r = extractAddressFromRecoveredOwner({
      name: "田中太郎",
      address: "",
      zip: null,
    });
    expect(r).toBeNull();
  });
});

// ── checkOwnerArchiveSafety（Phase 2-A） ───────────────────────────────────

describe("checkOwnerArchiveSafety", () => {
  const baseOk = {
    isArchived: false,
    versionMatches: true,
    propertyOwnerCount: 0,
    changeLogCount: 0,
    hasNote: false,
    hasExternalLinkKey: false,
    version: 1,
    importRowCount: 1,
    importRowSuccess: true,
    addressMissing: false,
  };

  it("全条件を満たすと ok", () => {
    expect(checkOwnerArchiveSafety(baseOk)).toEqual({ ok: true });
  });

  it("isArchived=true → owner_archived", () => {
    const r = checkOwnerArchiveSafety({ ...baseOk, isArchived: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("owner_archived");
  });

  it("versionMatches=false → version_mismatch", () => {
    const r = checkOwnerArchiveSafety({ ...baseOk, versionMatches: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("version_mismatch");
  });

  it("propertyOwnerCount>0 → property_owner_exists", () => {
    const r = checkOwnerArchiveSafety({ ...baseOk, propertyOwnerCount: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("property_owner_exists");
  });

  it("hasNote=true → note_exists", () => {
    const r = checkOwnerArchiveSafety({ ...baseOk, hasNote: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("note_exists");
  });

  it("hasExternalLinkKey=true → external_link_key_exists", () => {
    const r = checkOwnerArchiveSafety({ ...baseOk, hasExternalLinkKey: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("external_link_key_exists");
  });

  it("changeLogCount>0 → not_delete_candidate", () => {
    const r = checkOwnerArchiveSafety({ ...baseOk, changeLogCount: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("not_delete_candidate");
  });

  it("version>1 → not_delete_candidate", () => {
    const r = checkOwnerArchiveSafety({ ...baseOk, version: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("not_delete_candidate");
  });

  it("importRowCount=0 → import_source_unsafe", () => {
    const r = checkOwnerArchiveSafety({ ...baseOk, importRowCount: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("import_source_unsafe");
  });

  it("importRowCount>1 → import_source_unsafe", () => {
    const r = checkOwnerArchiveSafety({ ...baseOk, importRowCount: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("import_source_unsafe");
  });

  it("importRowSuccess=false → import_source_unsafe", () => {
    const r = checkOwnerArchiveSafety({ ...baseOk, importRowSuccess: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("import_source_unsafe");
  });

  it("複数違反は全件返す", () => {
    const r = checkOwnerArchiveSafety({
      ...baseOk,
      propertyOwnerCount: 2,
      hasNote: true,
      versionMatches: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reasons).toEqual(
        expect.arrayContaining([
          "version_mismatch",
          "property_owner_exists",
          "note_exists",
        ]),
      );
    }
  });

  it("addressMissing=true → address_missing", () => {
    const r = checkOwnerArchiveSafety({ ...baseOk, addressMissing: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("address_missing");
  });

  it("addressMissing=false → address_missing は返さない", () => {
    const r = checkOwnerArchiveSafety({ ...baseOk, addressMissing: false });
    expect(r).toEqual({ ok: true });
  });
});
