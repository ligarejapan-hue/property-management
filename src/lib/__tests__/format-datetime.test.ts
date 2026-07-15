import { describe, it, expect } from "vitest";
import { formatJaDateTime } from "../format-datetime";

// ローカルタイムゾーン基準の整形なので、検証も Date のローカル構築で行う
// (toISOString 経由の往復でタイムゾーン非依存にする)。
describe("formatJaDateTime", () => {
  it("1桁の時・月・日をゼロ埋めする(9:05→09:05・7月→07)", () => {
    const d = new Date(2026, 6, 5, 9, 5, 3); // 2026-07-05 09:05:03 (local)
    expect(formatJaDateTime(d)).toBe("2026/07/05 09:05:03");
  });

  it("2桁はそのまま保持する", () => {
    const d = new Date(2026, 10, 12, 13, 45, 59); // 2026-11-12 13:45:59
    expect(formatJaDateTime(d)).toBe("2026/11/12 13:45:59");
  });

  it("真夜中は 00:00:00", () => {
    const d = new Date(2026, 0, 1, 0, 0, 0);
    expect(formatJaDateTime(d)).toBe("2026/01/01 00:00:00");
  });

  it("ISO 文字列(サーバー由来の createdAt 等)を受け取れる", () => {
    const d = new Date(2026, 0, 1, 8, 9, 7);
    // toISOString() は UTC だが、パースし直すと同じ瞬間=同じローカル成分になる
    expect(formatJaDateTime(d.toISOString())).toBe("2026/01/01 08:09:07");
  });

  it("null / undefined / 空文字 / 不正値は空文字を返す", () => {
    expect(formatJaDateTime(null)).toBe("");
    expect(formatJaDateTime(undefined)).toBe("");
    expect(formatJaDateTime("")).toBe("");
    expect(formatJaDateTime("not-a-date")).toBe("");
  });
});
