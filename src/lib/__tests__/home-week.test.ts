import { describe, it, expect } from "vitest";
import {
  addDaysYmd, buildWeekDays, dayLabel, hourRow, hourRowLabel, isYmd, jstDateTime, weekRangeUtc, weekStartOf, type WeekItem,
} from "@/lib/home/week";

const item = (p: Partial<WeekItem>): WeekItem => ({
  key: "k", kind: "next_action", date: "2026-11-09", time: null, title: "t", sub: null, who: null,
  href: "/x", desk: false, overdue: false, ...p,
});

describe("今週の予定の部品(案4)", () => {
  it("週の初めは月曜(日曜は前の週)", () => {
    expect(weekStartOf("2026-11-09")).toBe("2026-11-09"); // 月
    expect(weekStartOf("2026-11-13")).toBe("2026-11-09"); // 金
    expect(weekStartOf("2026-11-15")).toBe("2026-11-09"); // 日
    expect(weekStartOf("2026-11-16")).toBe("2026-11-16");
    expect(weekStartOf("2026-03-01")).toBe("2026-02-23"); // 月をまたぐ
  });
  it("週の範囲は日本時間の月曜 0:00〜翌月曜 0:00", () => {
    const { from, to } = weekRangeUtc("2026-11-09");
    expect(from.toISOString()).toBe("2026-11-08T15:00:00.000Z");
    expect(to.toISOString()).toBe("2026-11-15T15:00:00.000Z");
  });
  it("時刻つきの値は日本時間の日付と時刻にする(日付の境目)", () => {
    expect(jstDateTime(new Date("2026-11-09T15:30:00Z"))).toEqual({ date: "2026-11-10", time: "00:30" });
    expect(jstDateTime(new Date("2026-11-10T01:00:00Z"))).toEqual({ date: "2026-11-10", time: "10:00" });
  });
  it("日付の形を確かめる(存在しない日は不可)", () => {
    expect(isYmd("2026-11-09")).toBe(true);
    expect(isYmd("2026-02-30")).toBe(false);
    expect(isYmd("2026/11/09")).toBe(false);
    expect(isYmd("x")).toBe(false);
  });
  it("時刻の行は 8時〜19時。外の予定は端の行にまとめる", () => {
    expect(hourRow("07:30")).toBe(8);
    expect(hourRow("10:59")).toBe(10);
    expect(hourRow("21:00")).toBe(19);
    expect(hourRowLabel(8)).toBe("〜8時");
    expect(hourRowLabel(12)).toBe("12時");
    expect(hourRowLabel(19)).toBe("19時〜");
  });
  it("月〜金は必ず出し、土日は予定がある日だけ。時刻なしは終日にまとめ、時刻順に並べる", () => {
    const days = buildWeekDays("2026-11-09", [
      item({ key: "a", date: "2026-11-10", time: "13:00" }),
      item({ key: "b", date: "2026-11-10", time: "09:30" }),
      item({ key: "c", date: "2026-11-10", time: null }),
      item({ key: "d", date: "2026-11-14", time: "10:00", kind: "viewing" }),
      item({ key: "x", date: "2026-11-16" }), // 次の週=捨てる
    ], "2026-11-10");
    expect(days.map((d) => d.date)).toEqual(["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14"]);
    const tue = days[1];
    expect(tue.isToday).toBe(true);
    expect(tue.allDay.map((i) => i.key)).toEqual(["c"]);
    expect(tue.timed.map((i) => i.key)).toEqual(["b", "a"]);
    expect(days.flatMap((d) => [...d.allDay, ...d.timed]).some((i) => i.key === "x")).toBe(false);
  });
  it("曜日の見出しと日付の足し算", () => {
    expect(dayLabel("2026-11-10")).toBe("火 11/10");
    expect(addDaysYmd("2026-12-28", 7)).toBe("2027-01-04");
  });
});
