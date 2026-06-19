/**
 * detectCompanyRegistryNumberInOwnerLike(12桁) のテスト。
 * ラベル付き(会社法人等番号/法人等番号)のみ検出・裸12桁/13桁は対象外・dedup。
 */
import { describe, it, expect } from "vitest";
import { detectCompanyRegistryNumberInOwnerLike } from "../corporate-number";

describe("detectCompanyRegistryNumberInOwnerLike", () => {
  it("ラベル付き12桁を note から検出する", () => {
    const r = detectCompanyRegistryNumberInOwnerLike({
      name: "株式会社サンプル",
      address: "東京都千代田区丸の内1-1-1",
      note: "会社法人等番号 0123-45-678901",
    });
    expect(r.candidates).toEqual(["012345678901"]);
    expect(r.detectedIn).toEqual(["note"]);
  });

  it("name / address のラベル付き12桁も検出し detectedIn に記録する", () => {
    const r = detectCompanyRegistryNumberInOwnerLike({
      name: "会社法人等番号 012345678901 のメモ",
      address: "法人等番号: 998877665544",
      note: null,
    });
    expect(r.candidates.sort()).toEqual(["012345678901", "998877665544"].sort());
    expect(r.detectedIn.sort()).toEqual(["address", "name"].sort());
  });

  it("全角・ハイフン混じりのラベル付き12桁を正規化して検出する", () => {
    const r = detectCompanyRegistryNumberInOwnerLike({
      name: null,
      address: null,
      note: "会社法人等番号 ０２００−０１−０１２３４５",
    });
    expect(r.candidates).toEqual(["020001012345"]);
  });

  it("裸の12桁(ラベルなし)は検出しない(誤検出回避)", () => {
    const r = detectCompanyRegistryNumberInOwnerLike({
      name: "株式会社サンプル",
      address: "東京都千代田区丸の内1-1-1",
      note: "電話 012345678901 / 担当 田中",
    });
    expect(r.candidates).toEqual([]);
    expect(r.detectedIn).toEqual([]);
  });

  it("13桁(法人番号)は12桁検出器では拾わない(別物)", () => {
    const r = detectCompanyRegistryNumberInOwnerLike({
      name: null,
      address: null,
      note: "法人番号 8700110005901",
    });
    expect(r.candidates).toEqual([]);
  });

  it("複数フィールドの同一値は dedup される", () => {
    const r = detectCompanyRegistryNumberInOwnerLike({
      name: "会社法人等番号 012345678901",
      address: "会社法人等番号 012345678901",
      note: null,
    });
    expect(r.candidates).toEqual(["012345678901"]);
    expect(r.detectedIn.sort()).toEqual(["address", "name"].sort());
  });

  it("検出なし / null フィールド → 空", () => {
    expect(
      detectCompanyRegistryNumberInOwnerLike({
        name: "個人 山田太郎",
        address: null,
        note: null,
      }),
    ).toEqual({ candidates: [], detectedIn: [] });
  });
});
