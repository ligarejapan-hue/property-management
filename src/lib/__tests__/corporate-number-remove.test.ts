import { describe, it, expect } from "vitest";
import { removeCorporateNumbersFromText } from "../corporate-number";

const N = "1234567890123";

describe("removeCorporateNumbersFromText", () => {
  it("裸13桁を除去し前後の余白を整える", () => {
    expect(removeCorporateNumbersFromText(`株式会社○○ ${N}`, [N])).toBe("株式会社○○");
  });
  it("ラベル付き(ラベル+区切り+番号)をまとめて除去", () => {
    expect(removeCorporateNumbersFromText(`株式会社○○ 法人番号:${N} 備考`, [N])).toBe(
      "株式会社○○ 備考",
    );
  });
  it("全角数字の混入も除去(normalize一致)", () => {
    expect(removeCorporateNumbersFromText("株式会社○○ １２３４５６７８９０１２３", [N])).toBe(
      "株式会社○○",
    );
  });
  it("ラベル付きハイフン区切りも除去", () => {
    expect(removeCorporateNumbersFromText(`法人番号: 1234-56-7890123`, [N])).toBe("");
  });
  it("対象外の番号は残す(部分削除)", () => {
    expect(removeCorporateNumbersFromText(`${N} 9999999999999`, [N])).toBe("9999999999999");
  });
  it("先頭/末尾の孤立区切りを除去", () => {
    expect(removeCorporateNumbersFromText(`株式会社○○、${N}`, [N])).toBe("株式会社○○");
  });
  it("numbers が空なら入力をそのまま返す", () => {
    expect(removeCorporateNumbersFromText(`株式会社○○ ${N}`, [])).toBe(`株式会社○○ ${N}`);
  });
  it("null 入力は null", () => {
    expect(removeCorporateNumbersFromText(null, [N])).toBeNull();
    expect(removeCorporateNumbersFromText(undefined, [N])).toBeNull();
  });
  it("番号のみの文字列は空文字になる", () => {
    expect(removeCorporateNumbersFromText(N, [N])).toBe("");
  });

  it("除去対象が無いフィールドは tidy せず原文を返す(無関係な空白を変更しない・Codex P2)", () => {
    expect(removeCorporateNumbersFromText("東京都　港区", [N])).toBe("東京都　港区");
    expect(removeCorporateNumbersFromText("  株式会社○○  ", [N])).toBe("  株式会社○○  ");
  });

  it("ハイフン連結IDの先頭13桁を裸番号として除去しない(1234567890123-45・Codex P2)", () => {
    expect(removeCorporateNumbersFromText("整理番号 1234567890123-45", [N])).toBe(
      "整理番号 1234567890123-45",
    );
  });

  it("全角ハイフン連結IDも先頭13桁を裸番号として除去しない(1234567890123－45・Codex P2 round3)", () => {
    // 全角ハイフン U+FF0D。境界が ASCII '-' だけだと誤除去して "－45" に壊れる。
    expect(removeCorporateNumbersFromText("整理番号 1234567890123－45", [N])).toBe(
      "整理番号 1234567890123－45",
    );
  });

  // ── Codex 追加 P1: 12桁会社法人等番号ラベル値の後に空白+数字住所が続くと、
  // 13桁除去器が空白を跨いで合成した擬似13桁(例 0200010123451)を numbersToRemove に
  // 持っていても、空白跨ぎの値はそもそも13桁としてマッチしない=住所を壊さない。
  it("12桁会社法人等番号+空白+数字住所を擬似13桁として除去しない(住所を壊さない)", () => {
    const bogus13 = "0200010123451"; // 12桁 + 住所先頭の "1" を空白跨ぎで合成した擬似値
    expect(
      removeCorporateNumbersFromText("会社法人等番号 0200-01-012345 1丁目", [bogus13]),
    ).toBe("会社法人等番号 0200-01-012345 1丁目");
  });
});
