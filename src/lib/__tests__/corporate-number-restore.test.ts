/**
 * corporate-number-restore.ts(割れた会社法人等番号の復元・純関数)のテスト。
 *
 * 背景: 外部exe由来の所有者Excelで、登記PDFの固定幅折返しにより
 * 会社法人等番号(12桁)が「住所末尾に前半断片」「氏名に後半数字」へ分断されて
 * 取り込まれた実データ(本番28+11件・2026-07-13調査)を復元する。
 *
 * 実データ形状(全角数字・全角ハイフン):
 *  - 住所: "東京都渋谷区…２１Ｆ会社法人等番号０１１０－０１－０" + 氏名: "５９４４２"
 *  - 氏名: "株式会社〇〇会社法人等番号０１２４－０１－０"(会社名+尻切れ断片)
 */
import { describe, it, expect } from "vitest";
import { detectSplitCorporateOwner } from "../corporate-number-restore";

describe("detectSplitCorporateOwner: 住所+氏名 分断型(address_name_split)", () => {
  it("実データ形状(全角7桁+全角5桁)を12桁に復元し13桁を算出する", () => {
    const r = detectSplitCorporateOwner({
      name: "５９４４２",
      address:
        "東京都渋谷区渋谷二丁目１７番１号渋谷アクシュ２１Ｆ会社法人等番号０１１０－０１－０",
    });
    expect(r).not.toBeNull();
    expect(r!.type).toBe("address_name_split");
    expect(r!.companyRegistryNumber12).toBe("011001059442");
    // 13桁 = チェックデジット + 12桁(算出値はcalculateCorporateNumberFromCompanyNumberに委譲)
    expect(r!.corporateNumber13).toMatch(/^\d13$/.test("x") ? /x/ : /^\d{13}$/);
    expect(r!.corporateNumber13!.slice(1)).toBe("011001059442");
    // 住所からラベル+断片が除去される
    expect(r!.cleanedAddress).toBe(
      "東京都渋谷区渋谷二丁目１７番１号渋谷アクシュ２１Ｆ",
    );
    // 会社名は失われている(国税庁から復元する)ので cleanedName は null
    expect(r!.cleanedName).toBeNull();
  });

  it("半角数字・半角ハイフンでも復元できる", () => {
    const r = detectSplitCorporateOwner({
      name: "59442",
      address: "東京都千代田区丸の内1-1-1 会社法人等番号0110-01-0",
    });
    expect(r).not.toBeNull();
    expect(r!.companyRegistryNumber12).toBe("011001059442");
  });

  it("「法人等番号」ラベル(会社なし)でも検出する", () => {
    const r = detectSplitCorporateOwner({
      name: "５９４４２",
      address: "東京都港区テスト1丁目 法人等番号０１１０－０１－０",
    });
    expect(r).not.toBeNull();
    expect(r!.type).toBe("address_name_split");
  });

  it("分割位置が違っても(4桁+8桁)合計12桁なら復元する", () => {
    const r = detectSplitCorporateOwner({
      name: "０１０５９４４２",
      address: "東京都新宿区西新宿2-8-1会社法人等番号０１１０",
    });
    expect(r).not.toBeNull();
    expect(r!.companyRegistryNumber12).toBe("011001059442");
  });

  it("合計が12桁にならない場合は復元しない(氏名断片が別物)", () => {
    const r = detectSplitCorporateOwner({
      name: "１２３", // 7+3=10桁
      address: "東京都渋谷区…会社法人等番号０１１０－０１－０",
    });
    expect(r).toBeNull();
  });

  it("住所の断片が完全な12桁なら対象外(既存の12桁検出に委譲)", () => {
    const r = detectSplitCorporateOwner({
      name: "５９４４２",
      address: "東京都渋谷区…会社法人等番号０１１０－０１－０５９４４２",
    });
    expect(r).toBeNull();
  });

  it("氏名が数字でなければ分断型としては検出しない", () => {
    const r = detectSplitCorporateOwner({
      name: "田中一郎",
      address: "東京都渋谷区…会社法人等番号０１１０－０１－０",
    });
    expect(r).toBeNull();
  });

  it("断片が住所の途中(末尾以外)にある場合は検出しない", () => {
    const r = detectSplitCorporateOwner({
      name: "５９４４２",
      address: "会社法人等番号０１１０－０１－０ 東京都渋谷区神南1-1",
    });
    expect(r).toBeNull();
  });

  it("ラベルが無い住所は検出しない", () => {
    const r = detectSplitCorporateOwner({
      name: "５９４４２",
      address: "東京都渋谷区神南1-1-1",
    });
    expect(r).toBeNull();
  });

  it("address null / name null は安全に null", () => {
    expect(detectSplitCorporateOwner({ name: null, address: null })).toBeNull();
    expect(
      detectSplitCorporateOwner({ name: "５９４４２", address: null }),
    ).toBeNull();
    expect(detectSplitCorporateOwner({ name: null, address: "会社法人等番号０１１０－０１－０" })).toBeNull();
  });
});

describe("detectSplitCorporateOwner: 氏名内断片型(name_fragment)", () => {
  it("実データ形状(会社名+ラベル+尻切れ断片)から会社名を救出する", () => {
    const r = detectSplitCorporateOwner({
      name: "株式会社テスト商事会社法人等番号０１２４－０１－０",
      address: "東京都中央区銀座1-1-1",
    });
    expect(r).not.toBeNull();
    expect(r!.type).toBe("name_fragment");
    expect(r!.cleanedName).toBe("株式会社テスト商事");
    // 断片は12桁に満たないため番号は復元不能
    expect(r!.companyRegistryNumber12).toBeNull();
    expect(r!.corporateNumber13).toBeNull();
    // 住所は触らない
    expect(r!.cleanedAddress).toBeNull();
  });

  it("会社名が空(氏名がラベル+断片のみ)なら cleanedName は null(自動修復不可)", () => {
    const r = detectSplitCorporateOwner({
      name: "会社法人等番号２９００－０１－０",
      address: "北海道札幌市…",
    });
    expect(r).not.toBeNull();
    expect(r!.type).toBe("name_fragment");
    expect(r!.cleanedName).toBeNull();
  });

  it("氏名内の断片が完全な12桁なら対象外(既存のラベル付き12桁検出に委譲)", () => {
    const r = detectSplitCorporateOwner({
      name: "株式会社テスト商事会社法人等番号０１２４－０１－０１２３４５",
      address: "東京都中央区銀座1-1-1",
    });
    expect(r).toBeNull();
  });

  it("普通の法人名(ラベルなし)は検出しない", () => {
    const r = detectSplitCorporateOwner({
      name: "株式会社テスト商事",
      address: "東京都中央区銀座1-1-1",
    });
    expect(r).toBeNull();
  });
});

describe("優先順位: 分断型が成立するときは分断型を返す", () => {
  it("住所末尾断片+数字氏名が成立していれば address_name_split", () => {
    const r = detectSplitCorporateOwner({
      name: "59442",
      address: "東京都会社法人等番号0110-01-0",
    });
    expect(r!.type).toBe("address_name_split");
  });
});
