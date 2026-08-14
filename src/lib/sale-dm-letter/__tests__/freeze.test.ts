import { describe, it, expect } from "vitest";
import { isVariantFrozen } from "../freeze";

// 型の凍結は**二重判定**（設計 §2.4 @codex R13→R22）:
//   列 template_frozen_at が立っている **OR** 配下に confirmed/sent の draft がある。
// 列は「割当で証拠(confirmed draft)が型から離れても残る」永続の根拠、
// 派生は「列がまだ立っていない窓（照合スクリプト完了前）」を塞ぐ即効の根拠。
// 互いの穴を補完するので、どちらか一方だけにしない。

describe("isVariantFrozen", () => {
  it("列が立っていれば凍結(配下に確定が無くても)", () => {
    expect(
      isVariantFrozen({ templateFrozenAt: new Date(), settledCount: 0 }),
    ).toBe(true);
  });

  it("配下に確定/送付済みがあれば凍結(列がまだ立っていなくても)", () => {
    expect(isVariantFrozen({ templateFrozenAt: null, settledCount: 1 })).toBe(
      true,
    );
  });

  it("どちらも無ければ未凍結", () => {
    expect(isVariantFrozen({ templateFrozenAt: null, settledCount: 0 })).toBe(
      false,
    );
  });

  it("両方あっても凍結", () => {
    expect(
      isVariantFrozen({ templateFrozenAt: new Date(), settledCount: 3 }),
    ).toBe(true);
  });
});
