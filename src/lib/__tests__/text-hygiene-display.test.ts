/**
 * DQ-04 監査表示ヘルパ visualizeTextHygiene の純関数テスト。
 * 不可視・双方向制御・U+FFFD を \uXXXX へエスケープし、bidi RLO による表示順改変を
 * 無害化すること（Codex P2）と、通常文字・全角・改行/タブ・絵文字を壊さないことを固定する。
 */
import { describe, it, expect } from "vitest";
import { visualizeTextHygiene } from "../text-hygiene-display";

const NUL = String.fromCharCode(0x00);
const VT = String.fromCharCode(0x0b);
const DEL = String.fromCharCode(0x7f);
const C1 = String.fromCharCode(0x85);
const ZWSP = String.fromCharCode(0x200b);
const ZWJ = String.fromCharCode(0x200d);
const BOM = String.fromCharCode(0xfeff);
const RLO = String.fromCharCode(0x202e);
const LRM = String.fromCharCode(0x200e);
const FFFD = String.fromCharCode(0xfffd);

describe("visualizeTextHygiene", () => {
  it("制御文字（C0/VT/DEL/C1）を \\uXXXX へエスケープ", () => {
    expect(visualizeTextHygiene(`a${NUL}b`)).toBe("a\\u0000b");
    expect(visualizeTextHygiene(`a${VT}b`)).toBe("a\\u000Bb");
    expect(visualizeTextHygiene(`a${DEL}b`)).toBe("a\\u007Fb");
    expect(visualizeTextHygiene(`a${C1}b`)).toBe("a\\u0085b");
  });

  it("ゼロ幅 / BOM / 双方向制御を \\uXXXX へエスケープ", () => {
    expect(visualizeTextHygiene(`a${ZWSP}b`)).toBe("a\\u200Bb");
    expect(visualizeTextHygiene(`a${ZWJ}b`)).toBe("a\\u200Db");
    expect(visualizeTextHygiene(`${BOM}x`)).toBe("\\uFEFFx");
    expect(visualizeTextHygiene(`a${RLO}b`)).toBe("a\\u202Eb");
    expect(visualizeTextHygiene(`a${LRM}b`)).toBe("a\\u200Eb");
  });

  it("U+FFFD（置換文字）をエスケープ", () => {
    expect(visualizeTextHygiene(`住所${FFFD}番地`)).toBe("住所\\uFFFD番地");
  });

  it("RLO を無害化する（生の RLO を含まない＝表示順を改変できない）", () => {
    const out = visualizeTextHygiene(`123${RLO}456`);
    expect(out).not.toContain(RLO);
    expect(out).toContain("\\u202E");
    expect(out).toBe("123\\u202E456");
  });

  it("通常文字・全角・改行/タブは不変（\\t\\n\\r は対象外）", () => {
    expect(visualizeTextHygiene("田中太郎")).toBe("田中太郎");
    expect(visualizeTextHygiene("Yamada Taro")).toBe("Yamada Taro");
    expect(visualizeTextHygiene("東京　都")).toBe("東京　都"); // 全角空白は保持
    expect(visualizeTextHygiene("a\tb\nc\rd")).toBe("a\tb\nc\rd");
  });

  it("絵文字（astral / surrogate pair）を壊さない", () => {
    expect(visualizeTextHygiene("家🏠")).toBe("家🏠");
    expect(visualizeTextHygiene("👨‍👩‍👧")).toContain("👨"); // ZWJ 結合絵文字: ZWJ はエスケープされ得るが本体は保持
  });

  it("空 / null / undefined は空文字", () => {
    expect(visualizeTextHygiene("")).toBe("");
    expect(visualizeTextHygiene(null)).toBe("");
    expect(visualizeTextHygiene(undefined)).toBe("");
  });

  it("複数の混在を順序通りにエスケープ", () => {
    expect(visualizeTextHygiene(`${NUL}田${ZWSP}中${RLO}`)).toBe(
      "\\u0000田\\u200B中\\u202E",
    );
  });
});
