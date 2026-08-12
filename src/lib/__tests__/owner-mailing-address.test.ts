/**
 * 送付に使う宛先の解決（現住所を優先し、無ければ登記上）。
 *
 * 設計: docs/superpowers/specs/2026-08-10-owner-current-address-design.md §4 / §4.0
 *
 * ⚠この関数の肝は2つ:
 *  1. **zip と address は必ず同じ側から取る**。混ぜると「新しい住所に古い郵便番号」を
 *     刷った郵便物ができる。
 *  2. **形式を理由に郵便番号を捨てない**。isValidPostalCode は日本の7桁専用で、
 *     所有者の郵便番号は自由入力（海外の番号も入る）。構文では「日本の書き損じ」と
 *     「正しい海外の番号」を区別できないため、捨てると国際郵便が届かなくなる。
 */
import { describe, it, expect } from "vitest";
import {
  resolveMailingAddress,
  resolveGroupZip,
} from "@/lib/owner-mailing-address";

const owner = (o: Partial<Parameters<typeof resolveMailingAddress>[0]>) => ({
  zip: null,
  address: null,
  currentZip: null,
  currentAddress: null,
  ...o,
});

describe("resolveMailingAddress — 現住所を優先し、必ずペアで取る", () => {
  it("現住所（住所+郵便番号）があればそちらを使う", () => {
    expect(
      resolveMailingAddress(
        owner({
          zip: "231-0842",
          address: "横浜市南区井土ケ谷中町69-2",
          currentZip: "150-0001",
          currentAddress: "渋谷区神宮前1-1-1",
        }),
      ),
    ).toEqual({
      zip: "150-0001",
      address: "渋谷区神宮前1-1-1",
      source: "current",
    });
  });

  it("現住所が無ければ登記上を使う", () => {
    expect(
      resolveMailingAddress(
        owner({ zip: "231-0842", address: "横浜市南区井土ケ谷中町69-2" }),
      ),
    ).toEqual({
      zip: "231-0842",
      address: "横浜市南区井土ケ谷中町69-2",
      source: "registry",
    });
  });

  it("⚠現住所はあるが現住所の郵便番号が空なら、郵便番号は空（登記上を混ぜない）", () => {
    // ここで登記上の郵便番号を混ぜると「新しい住所に古い郵便番号」になる。
    expect(
      resolveMailingAddress(
        owner({
          zip: "231-0842",
          address: "横浜市南区井土ケ谷中町69-2",
          currentAddress: "渋谷区神宮前1-1-1",
        }),
      ),
    ).toEqual({ zip: null, address: "渋谷区神宮前1-1-1", source: "current" });
  });

  it("現住所が空白のみなら「未設定」として登記上を使う", () => {
    expect(
      resolveMailingAddress(
        owner({
          zip: "231-0842",
          address: "横浜市南区井土ケ谷中町69-2",
          currentAddress: "   ",
        }),
      ).source,
    ).toBe("registry");
  });

  it("どちらも無ければ none（送付先不明）", () => {
    expect(resolveMailingAddress(owner({})).source).toBe("none");
    expect(resolveMailingAddress(owner({ address: "  " })).source).toBe("none");
  });

  it("⚠海外の郵便番号を形式で捨てない", () => {
    // 日本の7桁でないという理由で消すと、国際郵便が届かなくなる。
    for (const z of ["10001", "100000", "SW1A 1AA", "75001"]) {
      expect(
        resolveMailingAddress(
          owner({ currentZip: z, currentAddress: "海外の住所" }),
        ).zip,
        `${z} が消えている`,
      ).toBe(z);
    }
  });

  it("登記上側の郵便番号も形式で捨てない", () => {
    expect(
      resolveMailingAddress(owner({ zip: "10001", address: "海外の住所" })).zip,
    ).toBe("10001");
  });
});

describe("resolveGroupZip — 1通に刷る郵便番号を決める（設計 §4.0）", () => {
  it("全員空なら空", () => {
    expect(resolveGroupZip([null, "", "   "])).toBeNull();
  });

  it("非空が1種類ならそれを使う（代表が持っていなくてもよい）", () => {
    expect(resolveGroupZip([null, "150-0001", null])).toBe("150-0001");
  });

  it("⚠書き方違いは同じ番号として扱う（正規化してから比べる）", () => {
    // 生の値で比べると「食い違い」と誤判定し、正しい番号があるのに空で刷ってしまう。
    expect(resolveGroupZip(["1500001", "150-0001"])).not.toBeNull();
  });

  it("⚠正規化しても2種類あるなら空にする（どちらが正しいか決められない）", () => {
    expect(resolveGroupZip(["150-0001", "231-0842"])).toBeNull();
  });

  it("海外の番号も同じ規則で扱う（形式では捨てない）", () => {
    expect(resolveGroupZip(["10001", "10001"])).toBe("10001");
    expect(resolveGroupZip(["10001", "75001"])).toBeNull();
  });
});
