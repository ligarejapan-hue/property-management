import { describe, it, expect } from "vitest";
import {
  encodeCsv,
  escapeCsvField,
  valueToCsvString,
} from "../csv-encode";

describe("escapeCsvField", () => {
  it("特殊文字なしはそのまま", () => {
    expect(escapeCsvField("hello")).toBe("hello");
    expect(escapeCsvField("東京都")).toBe("東京都");
    expect(escapeCsvField("")).toBe("");
  });

  it("カンマを含むフィールドはダブルクオートで囲う", () => {
    expect(escapeCsvField("a,b")).toBe('"a,b"');
  });

  it("改行を含むフィールドはダブルクオートで囲う", () => {
    expect(escapeCsvField("line1\nline2")).toBe('"line1\nline2"');
    expect(escapeCsvField("x\r\ny")).toBe('"x\r\ny"');
  });

  it("ダブルクオート自体は \"\" にエスケープ", () => {
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
  });

  it("前後の空白を含むフィールドは囲う", () => {
    expect(escapeCsvField(" leading")).toBe('" leading"');
    expect(escapeCsvField("trailing ")).toBe('"trailing "');
  });
});

describe("valueToCsvString", () => {
  it("null / undefined → 空文字", () => {
    expect(valueToCsvString(null)).toBe("");
    expect(valueToCsvString(undefined)).toBe("");
  });

  it("primitive はそのまま String 化", () => {
    expect(valueToCsvString("abc")).toBe("abc");
    expect(valueToCsvString(123)).toBe("123");
    expect(valueToCsvString(true)).toBe("true");
    expect(valueToCsvString(false)).toBe("false");
  });

  it("配列・オブジェクトは JSON.stringify される", () => {
    expect(valueToCsvString(["a", "b"])).toBe('["a","b"]');
    expect(valueToCsvString({ k: 1 })).toBe('{"k":1}');
  });
});

describe("encodeCsv", () => {
  it("ヘッダ + 単純行を CRLF 区切りで返す", () => {
    const csv = encodeCsv(
      ["a", "b"],
      [{ a: "1", b: "2" }, { a: "3", b: "4" }],
    );
    expect(csv).toBe("a,b\r\n1,2\r\n3,4");
  });

  it("ヘッダに無いキーは無視される / 行に無いキーは空セル", () => {
    const csv = encodeCsv(
      ["a", "b", "c"],
      [{ a: "1", c: "3" }],
    );
    expect(csv).toBe("a,b,c\r\n1,,3");
  });

  it("カンマ・改行・クオートを含む値を正しくエスケープ", () => {
    const csv = encodeCsv(
      ["x"],
      [{ x: 'has,comma "and quote"' }],
    );
    expect(csv).toBe('x\r\n"has,comma ""and quote"""');
  });

  it("bom: true で UTF-8 BOM が先頭に付く", () => {
    const csv = encodeCsv(["a"], [{ a: "1" }], { bom: true });
    // U+FEFF が先頭にあること
    expect(csv.codePointAt(0)).toBe(0xfeff);
    expect(csv.slice(1)).toBe("a\r\n1");
  });

  it("bom: false（既定）では BOM なし", () => {
    const csv = encodeCsv(["a"], [{ a: "1" }]);
    expect(csv.codePointAt(0)).toBe(0x61); // 'a'
  });

  it("空行配列でもヘッダ行だけは出力する", () => {
    const csv = encodeCsv(["a", "b"], []);
    expect(csv).toBe("a,b");
  });

  it("配列値を含む行は JSON 文字列でエンコードされる", () => {
    const csv = encodeCsv(
      ["owners"],
      [{ owners: ["山田", "鈴木"] }],
    );
    // JSON 文字列内のダブルクオートが "" にエスケープされて全体が囲われる
    expect(csv).toBe('owners\r\n"[""山田"",""鈴木""]"');
  });
});
