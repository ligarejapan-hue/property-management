/**
 * 法人の重複所有者をまとめる(2026-11-24 発注者承認)の純関数テスト。
 *
 * - 法人名のそろえ方(buildOwnerCorporateNameDuplicateKey)
 * - ペアが同じ所有者と言えるか(resolveOwnerMergeMatch)
 * - 法人のペアだけ門を緩める(checkOwnerMergeSafety)
 * - 法人のペアの項目の引き継ぎ(planCorporateFieldHandover)
 *
 * ⚠名前・住所はすべて架空。
 */
import { describe, it, expect } from "vitest";
import { buildOwnerCorporateNameDuplicateKey } from "../owner-correction";
import { hasCorporateMarkerWord } from "../owner-honorific";
import { resolveOwnerMergeMatch } from "../owner-merge-match";
import { checkOwnerMergeSafety } from "../owner-merge";
import {
  planCorporateFieldHandover,
  requiredCorporateHandoverPermissions,
} from "../owner-merge-corporate-handover";

describe("hasCorporateMarkerWord", () => {
  it("株式会社・(株)・㈱・有限会社・医療法人などを法人とみなす", () => {
    expect(hasCorporateMarkerWord("株式会社サンプル商事")).toBe(true);
    expect(hasCorporateMarkerWord("サンプル商事（株）")).toBe(true);
    expect(hasCorporateMarkerWord("㈱サンプル商事")).toBe(true);
    expect(hasCorporateMarkerWord("有限会社テスト工務店")).toBe(true);
    expect(hasCorporateMarkerWord("医療法人架空会")).toBe(true);
  });
  it("個人名・空は法人とみなさない", () => {
    expect(hasCorporateMarkerWord("山田太郎")).toBe(false);
    expect(hasCorporateMarkerWord("")).toBe(false);
    expect(hasCorporateMarkerWord(null)).toBe(false);
  });
});

describe("buildOwnerCorporateNameDuplicateKey", () => {
  it("(株)・㈱・株式会社 と空白・全角半角の違いをそろえる", () => {
    const a = buildOwnerCorporateNameDuplicateKey("株式会社 サンプル商事");
    const b = buildOwnerCorporateNameDuplicateKey("（株）サンプル商事");
    const c = buildOwnerCorporateNameDuplicateKey("㈱サンプル商事");
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("(有)→有限会社・(同)→合同会社 もそろえる", () => {
    expect(buildOwnerCorporateNameDuplicateKey("㈲テスト工務店")).toBe(
      buildOwnerCorporateNameDuplicateKey("有限会社テスト工務店"),
    );
    expect(buildOwnerCorporateNameDuplicateKey("(同)ミライ架空")).toBe(
      buildOwnerCorporateNameDuplicateKey("合同会社ミライ架空"),
    );
  });

  it("異体字(髙→高)と英字の大小をそろえる", () => {
    expect(buildOwnerCorporateNameDuplicateKey("株式会社髙架空興産")).toBe(
      buildOwnerCorporateNameDuplicateKey("株式会社高架空興産"),
    );
    expect(buildOwnerCorporateNameDuplicateKey("株式会社ＡＢＣ架空")).toBe(
      buildOwnerCorporateNameDuplicateKey("株式会社abc架空"),
    );
  });

  it("前株と後株は別の名前(そろえない)", () => {
    expect(buildOwnerCorporateNameDuplicateKey("株式会社サンプル商事")).not.toBe(
      buildOwnerCorporateNameDuplicateKey("サンプル商事株式会社"),
    );
  });

  it("法人の語が無い名前(個人)は null", () => {
    expect(buildOwnerCorporateNameDuplicateKey("山田太郎")).toBeNull();
    expect(buildOwnerCorporateNameDuplicateKey("  ")).toBeNull();
    expect(buildOwnerCorporateNameDuplicateKey(null)).toBeNull();
  });
});

const corpA = {
  name: "株式会社サンプル商事",
  address: "東京都架空区1-1",
  zip: null,
  phone: null,
  corporateNumber: null,
};

describe("resolveOwnerMergeMatch", () => {
  it("氏名住所が同じなら name_address(個人)", () => {
    const m = resolveOwnerMergeMatch(
      { ...corpA, name: "山田太郎" },
      { ...corpA, name: "山田 太郎" },
      { corporateNumberAvailable: true },
    );
    expect(m).toEqual({
      matchedBy: "name_address",
      corporatePair: false,
      corporateNumberConflict: false,
      companyRegistryNumberConflict: false,
    });
  });

  it("住所が違っても法人名が同じなら corporate_name(法人のペア)", () => {
    const m = resolveOwnerMergeMatch(
      corpA,
      { ...corpA, name: "㈱サンプル商事", address: "大阪府架空市2-2" },
      { corporateNumberAvailable: true },
    );
    expect(m.matchedBy).toBe("corporate_name");
    expect(m.corporatePair).toBe(true);
  });

  it("法人番号(13桁にそろえて)が同じなら corporate_number", () => {
    const m = resolveOwnerMergeMatch(
      { ...corpA, corporateNumber: "1234567890123" },
      {
        ...corpA,
        name: "サンプル商事",
        address: "大阪府架空市2-2",
        corporateNumber: "1234-5678-90123",
      },
      { corporateNumberAvailable: true },
    );
    expect(m.matchedBy).toBe("corporate_number");
    expect(m.corporatePair).toBe(true);
  });

  it("法人番号を見られない人には法人番号の経路を使わない", () => {
    const m = resolveOwnerMergeMatch(
      { ...corpA, corporateNumber: "1234567890123" },
      {
        ...corpA,
        name: "サンプル商事",
        address: "大阪府架空市2-2",
        corporateNumber: "1234567890123",
      },
      { corporateNumberAvailable: false },
    );
    expect(m.matchedBy).toBeNull();
  });

  it("両方に法人番号があって違うなら、名前が同じでも止める(corporate_number_conflict)", () => {
    const m = resolveOwnerMergeMatch(
      { ...corpA, corporateNumber: "1234567890123" },
      { ...corpA, corporateNumber: "9876543210987" },
      { corporateNumberAvailable: true },
    );
    expect(m.matchedBy).toBeNull();
    expect(m.corporateNumberConflict).toBe(true);
  });

  it("法人番号を見られない人には食い違いの理由を出さないが、同じ所有者とも扱わない", () => {
    const m = resolveOwnerMergeMatch(
      { ...corpA, corporateNumber: "1234567890123" },
      { ...corpA, corporateNumber: "9876543210987" },
      { corporateNumberAvailable: false },
    );
    expect(m.matchedBy).toBeNull();
    expect(m.corporateNumberConflict).toBe(false);
  });

  it("個人同士で住所が違えばどれにも当たらない", () => {
    const m = resolveOwnerMergeMatch(
      { ...corpA, name: "山田太郎" },
      { ...corpA, name: "山田太郎", address: "大阪府架空市2-2" },
      { corporateNumberAvailable: true },
    );
    expect(m.matchedBy).toBeNull();
    expect(m.corporatePair).toBe(false);
  });

  it("法人で氏名住所も同じなら name_address が先・法人のペアでもある", () => {
    const m = resolveOwnerMergeMatch(corpA, { ...corpA }, {
      corporateNumberAvailable: true,
    });
    expect(m.matchedBy).toBe("name_address");
    expect(m.corporatePair).toBe(true);
  });
});

const baseOk = {
  sameOwnerId: false,
  masterExists: true,
  sourceExists: true,
  masterIsArchived: false,
  sourceIsArchived: false,
  sourceChangeLogCount: 0,
  sourceHasNote: false,
  sourceHasExternalLinkKey: false,
  sourceVersion: 1,
  normalizeKeyMatches: true,
};

describe("checkOwnerMergeSafety: 法人のペアだけ門を緩める", () => {
  it("法人のペアは source の変更履歴・version>1 で止めない", () => {
    expect(
      checkOwnerMergeSafety({
        ...baseOk,
        corporatePair: true,
        sourceChangeLogCount: 3,
        sourceChangeLogFields: ["phone", "name", "address"],
        sourceVersion: 4,
      }),
    ).toEqual({ ok: true });
  });

  it("法人のペアでも source の備考・外部リンクキーは従来どおり止める", () => {
    const r = checkOwnerMergeSafety({
      ...baseOk,
      corporatePair: true,
      sourceHasNote: true,
      sourceHasExternalLinkKey: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reasons).toEqual(
        expect.arrayContaining(["source_has_note", "source_has_external_link_key"]),
      );
    }
  });

  it("個人(法人のペアでない)は従来どおり変更履歴・version>1 で止める", () => {
    const r = checkOwnerMergeSafety({
      ...baseOk,
      corporatePair: false,
      sourceChangeLogCount: 1,
      sourceVersion: 2,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reasons).toEqual(
        expect.arrayContaining(["source_has_changelog", "source_version_gt_1"]),
      );
    }
  });

  it("法人番号の食い違いは corporate_number_conflict(owner_identity_mismatch は重ねない)", () => {
    const r = checkOwnerMergeSafety({
      ...baseOk,
      normalizeKeyMatches: false,
      corporateNumberConflict: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reasons).toContain("corporate_number_conflict");
      expect(r.reasons).not.toContain("owner_identity_mismatch");
    }
  });

  it("どの経路にも当たらないペアは owner_identity_mismatch", () => {
    const r = checkOwnerMergeSafety({ ...baseOk, normalizeKeyMatches: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("owner_identity_mismatch");
  });
});

const emptyOwner = { address: null, zip: null, phone: null, corporateNumber: null };

describe("planCorporateFieldHandover", () => {
  it("残す側が空なら、消える側の住所(+郵便番号)・電話・法人番号を写す", () => {
    const plan = planCorporateFieldHandover(emptyOwner, {
      address: "大阪府架空市2-2",
      zip: "530-0000",
      phone: "06-0000-0000",
      corporateNumber: "1234-5678-90123",
    });
    expect(plan.writes).toEqual({
      address: "大阪府架空市2-2",
      zip: "530-0000",
      phone: "06-0000-0000",
      corporateNumber: "1234567890123",
    });
    expect(plan.keptSourceValues).toEqual([]);
    expect(plan.sourceAddress).toBe("大阪府架空市2-2");
  });

  it("両方に値があって違うなら写さず、消える側の値を記録に残す", () => {
    const plan = planCorporateFieldHandover(
      {
        address: "東京都架空区1-1",
        zip: "100-0000",
        phone: "03-0000-0000",
        corporateNumber: null,
      },
      {
        address: "大阪府架空市2-2",
        zip: "530-0000",
        phone: "06-0000-0000",
        corporateNumber: null,
      },
    );
    expect(plan.writes).toEqual({});
    // 住所は必ず残す記録(sourceAddress)で残るので、ここには重ねない
    expect(plan.keptSourceValues).toEqual([
      { field: "zip", value: "530-0000" },
      { field: "phone", value: "06-0000-0000" },
    ]);
    expect(plan.sourceAddress).toBe("大阪府架空市2-2");
  });

  it("同じ値(表記の違いだけ)なら何もしない", () => {
    const plan = planCorporateFieldHandover(
      {
        address: "東京都架空区1-1",
        zip: "1000000",
        phone: "03-0000-0000",
        corporateNumber: "1234567890123",
      },
      {
        address: "東京都架空区１－１",
        zip: "100-0000",
        phone: "0300000000",
        corporateNumber: "1234-5678-90123",
      },
    );
    expect(plan.writes).toEqual({});
    expect(plan.keptSourceValues).toEqual([]);
  });

  it("同じ住所で残す側の郵便番号だけ空なら、番号だけ写す", () => {
    const plan = planCorporateFieldHandover(
      { ...emptyOwner, address: "東京都架空区1-1" },
      { ...emptyOwner, address: "東京都架空区1-1", zip: "100-0000" },
    );
    expect(plan.writes).toEqual({ zip: "100-0000" });
  });

  it("消える側が空なら何も写さない(住所の記録は null)", () => {
    const plan = planCorporateFieldHandover(
      { ...emptyOwner, address: "東京都架空区1-1" },
      emptyOwner,
    );
    expect(plan.writes).toEqual({});
    expect(plan.keptSourceValues).toEqual([]);
    expect(plan.sourceAddress).toBeNull();
  });

  it("写す項目ごとに要る編集権限を返す", () => {
    const plan = planCorporateFieldHandover(emptyOwner, {
      address: "大阪府架空市2-2",
      zip: "530-0000",
      phone: "06-0000-0000",
      corporateNumber: "1234567890123",
    });
    expect(requiredCorporateHandoverPermissions(plan).sort()).toEqual(
      ["owner_address", "owner_corporate_number", "owner_phone", "owner_zip"].sort(),
    );
    expect(
      requiredCorporateHandoverPermissions(planCorporateFieldHandover(emptyOwner, emptyOwner)),
    ).toEqual([]);
  });
});

// ---- review P2: 法人のペアで source にだけある項目を落とさない ----
const fullEmpty = {
  name: "株式会社サンプル商事",
  nameKana: null,
  address: null,
  zip: null,
  phone: null,
  email: null,
  corporateNumber: null,
  companyRegistryNumber: null,
};

describe("planCorporateFieldHandover: メール・会社法人等番号・フリガナ・名前", () => {
  it("master が空ならメール・会社法人等番号(12桁にそろえる)・フリガナを写す", () => {
    const plan = planCorporateFieldHandover(fullEmpty, {
      ...fullEmpty,
      email: "info@example.invalid",
      companyRegistryNumber: "0100-01-012345",
      nameKana: "カブシキガイシャサンプルショウジ",
    });
    expect(plan.writes).toEqual({
      email: "info@example.invalid",
      companyRegistryNumber: "010001012345",
      nameKana: "カブシキガイシャサンプルショウジ",
    });
    expect(requiredCorporateHandoverPermissions(plan).sort()).toEqual(
      ["owner_corporate_number", "owner_email", "owner_name_kana"].sort(),
    );
  });

  it("両方にあって違えば写さず記録に残す(名前の書き方の違いも残す)", () => {
    const plan = planCorporateFieldHandover(
      { ...fullEmpty, email: "a@example.invalid", nameKana: "サンプル", companyRegistryNumber: "010001012345" },
      {
        ...fullEmpty,
        name: "㈱サンプル商事",
        email: "b@example.invalid",
        nameKana: "サンプルショウジ",
        companyRegistryNumber: "0100-01-012345",
      },
    );
    expect(plan.writes).toEqual({});
    expect(plan.keptSourceValues).toEqual([
      { field: "email", value: "b@example.invalid" },
      { field: "nameKana", value: "サンプルショウジ" },
      { field: "name", value: "㈱サンプル商事" },
    ]);
  });

  it("同じ値(大文字小文字・空白の違いだけ)なら何もしない", () => {
    const plan = planCorporateFieldHandover(
      { ...fullEmpty, email: "Info@Example.invalid", nameKana: "サンプル ショウジ" },
      { ...fullEmpty, name: " 株式会社サンプル商事 ", email: "info@example.invalid", nameKana: "サンプルショウジ" },
    );
    expect(plan.writes).toEqual({});
    expect(plan.keptSourceValues).toEqual([]);
  });
});

describe("会社法人等番号の食い違い", () => {
  it("両方にあって違えば companyRegistryNumberConflict(見られる人だけ)", () => {
    const a = { ...corpA, companyRegistryNumber: "010001012345" };
    const b = { ...corpA, companyRegistryNumber: "0200-01-054321" };
    const m = resolveOwnerMergeMatch(a, b, { corporateNumberAvailable: true });
    expect(m.matchedBy).toBeNull();
    expect(m.companyRegistryNumberConflict).toBe(true);
    const hidden = resolveOwnerMergeMatch(a, b, { corporateNumberAvailable: false });
    expect(hidden.matchedBy).toBeNull();
    expect(hidden.companyRegistryNumberConflict).toBe(false);
  });

  it("表記の違いだけなら食い違いにしない", () => {
    const m = resolveOwnerMergeMatch(
      { ...corpA, companyRegistryNumber: "010001012345" },
      { ...corpA, companyRegistryNumber: "0100-01-012345" },
      { corporateNumberAvailable: true },
    );
    expect(m.matchedBy).toBe("name_address");
    expect(m.companyRegistryNumberConflict).toBe(false);
  });

  it("safety は company_registry_number_conflict で止め、owner_identity_mismatch を重ねない", () => {
    const r = checkOwnerMergeSafety({
      ...baseOk,
      normalizeKeyMatches: false,
      companyRegistryNumberConflict: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reasons).toContain("company_registry_number_conflict");
      expect(r.reasons).not.toContain("owner_identity_mismatch");
    }
  });
});
