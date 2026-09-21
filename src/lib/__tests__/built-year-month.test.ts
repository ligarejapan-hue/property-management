import { describe, it, expect } from "vitest";
import { formatBuiltYearMonth } from "../built-year-month";

// [@codex P2] 築年と築月は別の列で、片方だけでも保存できる。表示側が「築年があるときだけ
// 出す」と書くと、築月だけ入れた値が保存されているのに画面から消える(編集フォームには
// 出るので「消えたように見えて消えていない」という一番分かりにくい状態になる)。
describe("formatBuiltYearMonth — 築年・築月の表示", () => {
  it("両方あれば年月", () => {
    expect(formatBuiltYearMonth(2015, 3)).toBe("2015年3月");
  });

  it("年だけなら年", () => {
    expect(formatBuiltYearMonth(2015, null)).toBe("2015年");
    expect(formatBuiltYearMonth(2015, undefined)).toBe("2015年");
  });

  it("月だけでも消さずに出す", () => {
    expect(formatBuiltYearMonth(null, 3)).toBe("3月");
    expect(formatBuiltYearMonth(undefined, 12)).toBe("12月");
  });

  it("どちらも無ければ空", () => {
    expect(formatBuiltYearMonth(null, null)).toBe("");
    expect(formatBuiltYearMonth(undefined, undefined)).toBe("");
  });
});
