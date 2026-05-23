/**
 * decodeXmlEntities / numeric entity の安全性テスト。
 *
 * 不正 numeric entity (range out / NaN / 巨大値) を渡しても:
 *   - RangeError を throw しない（500 にならない）
 *   - 入力全体は壊れず、不正部分のみ replacement character になる
 *   - 正常な amp/lt/gt/quot/apos / 通常 numeric entity は decode できる
 * extractTagText / extractCorporationBlocks 経由でも RangeError が漏れない。
 */
import { describe, it, expect } from "vitest";
import { extractTagText, extractCorporationBlocks } from "../xml-extract";

const REPLACEMENT_CHAR = "�";

describe("decodeXmlEntities (via extractTagText) — 正常系", () => {
  it("&amp; → &", () => {
    expect(extractTagText("<a>A&amp;B</a>", "a")).toBe("A&B");
  });
  it("&lt; / &gt; / &quot; / &apos;", () => {
    expect(extractTagText("<a>&lt;x&gt;</a>", "a")).toBe("<x>");
    expect(extractTagText('<a>&quot;hello&quot;</a>', "a")).toBe('"hello"');
    expect(extractTagText("<a>it&apos;s</a>", "a")).toBe("it's");
  });
  it("通常の decimal numeric entity (&#1234;) を decode する", () => {
    // 中 = U+4E2D = 20013
    expect(extractTagText("<a>&#20013;</a>", "a")).toBe("中");
  });
  it("通常の hex numeric entity (&#x4e2d;) を decode する", () => {
    expect(extractTagText("<a>&#x4e2d;</a>", "a")).toBe("中");
  });
});

describe("decodeXmlEntities — 不正 numeric entity でも RangeError にならない", () => {
  it("&#99999999; (0x10FFFF 超 = code point 範囲外) は throw せず replacement に置換", () => {
    expect(() => extractTagText("<a>X&#99999999;Y</a>", "a")).not.toThrow();
    const result = extractTagText("<a>X&#99999999;Y</a>", "a");
    expect(result).toBe(`X${REPLACEMENT_CHAR}Y`);
  });

  it("&#xFFFFFFFF; (32bit MAX) は throw せず replacement に置換", () => {
    expect(() => extractTagText("<a>X&#xFFFFFFFF;Y</a>", "a")).not.toThrow();
    const result = extractTagText("<a>X&#xFFFFFFFF;Y</a>", "a");
    expect(result).toBe(`X${REPLACEMENT_CHAR}Y`);
  });

  it("&#x110000; (0x10FFFF + 1 = code point ちょうど範囲外) も replacement", () => {
    const result = extractTagText("<a>&#x110000;</a>", "a");
    expect(result).toBe(REPLACEMENT_CHAR);
  });

  it("&#x10FFFF; (上限ちょうど) は decode できる", () => {
    expect(() => extractTagText("<a>&#x10FFFF;</a>", "a")).not.toThrow();
  });

  it("0 (&#0;) は decode する（NULL 文字）が throw しない", () => {
    expect(() => extractTagText("<a>&#0;</a>", "a")).not.toThrow();
  });

  it("大量の不正 entity 混在でも throw しない（全体 parse が壊れない）", () => {
    const xml = "<a>正常&#99999999;続き&#xFFFFFFFF;末尾</a>";
    expect(() => extractTagText(xml, "a")).not.toThrow();
    const result = extractTagText(xml, "a");
    expect(result).toContain("正常");
    expect(result).toContain("続き");
    expect(result).toContain("末尾");
  });
});

describe("extractCorporationBlocks — 不正 entity でも RangeError 不漏れ", () => {
  it("blocks 抽出は entity decode を行わないため安全", () => {
    const xml = "<corporation>&#99999999;</corporation>";
    expect(() => extractCorporationBlocks(xml)).not.toThrow();
    const blocks = extractCorporationBlocks(xml);
    expect(blocks).toHaveLength(1);
  });
});
