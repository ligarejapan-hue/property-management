import { describe, it, expect } from "vitest";
import { parseRegistryShare, sumRegistryShares, formatShare } from "@/lib/registry-entries/share";

/**
 * 所有者事項の持分(「10分の2」)の読み取りと合計(2026-11-12 発注者決定)。
 * - 合計は約分しない(2/10+3/10+2/10=7/10)。分母がそろわないときは通分して足す(1/2+1/4=3/4)。
 * - 持分が読めない行が1つでもあれば、合計は出さない(間違った合計を見せない)。
 */
describe("parseRegistryShare", () => {
  it("「10分の2」を 2/10 と読む", () => {
    expect(parseRegistryShare("10分の2")).toEqual({ num: 2, den: 10 });
  });

  it("全角の数字・前後の空白・「持分」の語が付いていても読む", () => {
    expect(parseRegistryShare(" １０分の３ ")).toEqual({ num: 3, den: 10 });
    expect(parseRegistryShare("持分4分の1")).toEqual({ num: 1, den: 4 });
  });

  it("桁区切りの入った大きな分母も読む", () => {
    expect(parseRegistryShare("100000分の2345")).toEqual({ num: 2345, den: 100000 });
  });

  it("読めない・あり得ない持分は null", () => {
    expect(parseRegistryShare(null)).toBeNull();
    expect(parseRegistryShare("")).toBeNull();
    expect(parseRegistryShare("全部")).toBeNull();
    expect(parseRegistryShare("0分の1")).toBeNull();
    expect(parseRegistryShare("10分の0")).toBeNull();
    expect(parseRegistryShare("2分の3")).toBeNull(); // 1を超える
    expect(parseRegistryShare("99999999999分の1")).toBeNull(); // DB の整数に入らない
  });
});

describe("sumRegistryShares", () => {
  it("分母が同じなら約分せずに足す", () => {
    expect(
      sumRegistryShares([
        { num: 2, den: 10 },
        { num: 3, den: 10 },
        { num: 2, den: 10 },
      ]),
    ).toEqual({ num: 7, den: 10 });
  });

  it("分母がそろわないときは通分して足す", () => {
    expect(
      sumRegistryShares([
        { num: 1, den: 2 },
        { num: 1, den: 4 },
      ]),
    ).toEqual({ num: 3, den: 4 });
  });

  it("1行だけならそのまま(約分しない)", () => {
    expect(sumRegistryShares([{ num: 2, den: 4 }])).toEqual({ num: 2, den: 4 });
  });

  it("持分が無い行が混じる・行が無い・1を超えるときは null", () => {
    expect(sumRegistryShares([{ num: 1, den: 2 }, null])).toBeNull();
    expect(sumRegistryShares([])).toBeNull();
    expect(
      sumRegistryShares([
        { num: 2, den: 3 },
        { num: 2, den: 3 },
      ]),
    ).toBeNull();
  });
});

describe("formatShare", () => {
  it("分子/分母 の形で出す", () => {
    expect(formatShare({ num: 7, den: 10 })).toBe("7/10");
  });
});
