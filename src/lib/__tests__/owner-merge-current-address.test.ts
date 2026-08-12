/**
 * 統合（名寄せ）での現住所の引き継ぎ（設計 §7）。
 *
 * ⚠ここが無いと、現住所を持つ側を統合した瞬間にその現住所が消える（復元不能）。
 */
import { describe, it, expect } from "vitest";
import {
  resolveCurrentAddressHandover,
  handoverWrites,
  isCurrentAddressOnlyChangeLog,
} from "@/lib/owner-merge-current-address";

const empty = { currentZip: null, currentAddress: null };

describe("引き継ぎ方の3通り", () => {
  it("残す側が空なら、ペアごと引き継ぐ", () => {
    expect(
      resolveCurrentAddressHandover(empty, {
        currentAddress: "渋谷区神宮前1-1-1",
        currentZip: "150-0001",
      }),
    ).toEqual({
      kind: "pair",
      currentAddress: "渋谷区神宮前1-1-1",
      currentZip: "150-0001",
    });
  });

  it("残す側が空・消える側に郵便番号が無ければ、住所だけ引き継ぐ", () => {
    expect(
      resolveCurrentAddressHandover(empty, {
        currentAddress: "渋谷区神宮前1-1-1",
        currentZip: null,
      }),
    ).toEqual({
      kind: "pair",
      currentAddress: "渋谷区神宮前1-1-1",
      currentZip: null,
    });
  });

  it("同じ宛先で残す側の郵便番号が空なら、番号だけ引き継ぐ", () => {
    expect(
      resolveCurrentAddressHandover(
        { currentAddress: "渋谷区神宮前1-1-1", currentZip: null },
        { currentAddress: "渋谷区神宮前1-1-1", currentZip: "150-0001" },
      ),
    ).toEqual({ kind: "zip_only", currentZip: "150-0001" });
  });

  it("同じ宛先・同じ番号なら何もしない", () => {
    expect(
      resolveCurrentAddressHandover(
        { currentAddress: "渋谷区神宮前1-1-1", currentZip: "1500001" },
        { currentAddress: "渋谷区神宮前1-1-1", currentZip: "150-0001" },
      ),
    ).toEqual({ kind: "none" });
  });
});

describe("統合させない組み合わせ", () => {
  it("⚠現住所が食い違うなら拒否（どちらが新しいか決められない）", () => {
    expect(
      resolveCurrentAddressHandover(
        { currentAddress: "渋谷区神宮前1-1-1", currentZip: null },
        { currentAddress: "横浜市南区井土ケ谷中町69-2", currentZip: null },
      ),
    ).toEqual({ kind: "conflict_address" });
  });

  it("⚠同じ住所で郵便番号だけ食い違うなら拒否", () => {
    // 統合前は「食い違い＝どちらも信用できない」として空で刷っていたのに、
    // 統合後は残った側の番号が「正しい番号」として刷られてしまう。
    expect(
      resolveCurrentAddressHandover(
        { currentAddress: "渋谷区神宮前1-1-1", currentZip: "150-0001" },
        { currentAddress: "渋谷区神宮前1-1-1", currentZip: "231-0842" },
      ),
    ).toEqual({ kind: "conflict_zip" });
  });
});

describe("引き継ぐものが無い場合", () => {
  it("消える側に現住所が無ければ何もしない", () => {
    expect(resolveCurrentAddressHandover(empty, empty)).toEqual({
      kind: "none",
    });
  });

  it("⚠住所の無い郵便番号だけは引き継がない（宛先にならない番号が残る）", () => {
    expect(
      resolveCurrentAddressHandover(empty, {
        currentAddress: null,
        currentZip: "150-0001",
      }),
    ).toEqual({ kind: "none" });
  });
});

describe("書き込みが起きるか", () => {
  it("ペア引き継ぎ・番号だけ引き継ぎは書き込みが起きる", () => {
    expect(
      handoverWrites({
        kind: "pair",
        currentAddress: "X",
        currentZip: null,
      }),
    ).toBe(true);
    expect(handoverWrites({ kind: "zip_only", currentZip: "1" })).toBe(true);
  });

  it("何もしない・拒否では書き込みが起きない", () => {
    expect(handoverWrites({ kind: "none" })).toBe(false);
    expect(handoverWrites({ kind: "conflict_address" })).toBe(false);
    expect(handoverWrites({ kind: "conflict_zip" })).toBe(false);
  });
});

describe("変更履歴が現住所の2列だけか", () => {
  it("現住所だけ・現住所+郵便番号だけなら true", () => {
    expect(isCurrentAddressOnlyChangeLog(["currentAddress"])).toBe(true);
    expect(
      isCurrentAddressOnlyChangeLog(["currentAddress", "currentZip"]),
    ).toBe(true);
  });

  it("⚠他の項目が1つでも混ざれば false（引き継がない項目が失われる）", () => {
    expect(isCurrentAddressOnlyChangeLog(["currentAddress", "phone"])).toBe(
      false,
    );
    expect(isCurrentAddressOnlyChangeLog(["address"])).toBe(false);
  });

  it("履歴が無いときは true にしない（緩和は履歴で説明できるときだけ）", () => {
    expect(isCurrentAddressOnlyChangeLog([])).toBe(false);
  });
});
