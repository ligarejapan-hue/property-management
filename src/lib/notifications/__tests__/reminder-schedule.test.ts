import { describe, it, expect } from "vitest";
import {
  REMINDER_STOP_MS,
  isTimedNextAction,
  jstToday,
  nextActionDeadline,
  nextActionReminderSlot,
  reminderSendOffsets,
} from "../reminder-schedule";

const H = 60 * 60 * 1000;
const M = 60 * 1000;
// 2026-10-02 9:00 JST = 2026-10-02T00:00:00Z
const T = Date.UTC(2026, 9, 2, 0, 0, 0);

describe("次回対応の送信予定(設計書 §7.4・D8/D16/D17)", () => {
  it("回の並び: 期限→2時間ごとに24時間→6時間ごとに72時間→12時間ごとに156時間(計28回)", () => {
    const offs = reminderSendOffsets(false).map((o) => o / H);
    expect(offs[0]).toBe(0);
    expect(offs.slice(1, 13)).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24]);
    expect(offs.slice(13, 21)).toEqual([30, 36, 42, 48, 54, 60, 66, 72]);
    expect(offs.slice(21)).toEqual([84, 96, 108, 120, 132, 144, 156]);
    expect(offs).toHaveLength(28);
  });
  it("時刻ありは最初の回が期限の5分前・期限ちょうどには送らない", () => {
    const offs = reminderSendOffsets(true);
    expect(offs[0]).toBe(-5 * M);
    expect(offs[1]).toBe(2 * H);
    expect(offs).not.toContain(0);
  });
  it("期限の前は回が無い", () => {
    expect(nextActionReminderSlot(T, T - 1)).toBeNull();
  });
  it("期限ちょうどは0回目・2時間未満も0回目", () => {
    expect(nextActionReminderSlot(T, T)).toBe(0);
    expect(nextActionReminderSlot(T, T + 2 * H - 1)).toBe(0);
  });
  it("+2h で1回目・+24h で12回目・+30h の直前まで12回目", () => {
    expect(nextActionReminderSlot(T, T + 2 * H)).toBe(1);
    expect(nextActionReminderSlot(T, T + 24 * H)).toBe(12);
    expect(nextActionReminderSlot(T, T + 30 * H - 1)).toBe(12);
    expect(nextActionReminderSlot(T, T + 30 * H)).toBe(13);
  });
  it("+72h で20回目・+84h で21回目・+156h で27回目", () => {
    expect(nextActionReminderSlot(T, T + 72 * H)).toBe(20);
    expect(nextActionReminderSlot(T, T + 84 * H - 1)).toBe(20);
    expect(nextActionReminderSlot(T, T + 84 * H)).toBe(21);
    expect(nextActionReminderSlot(T, T + 156 * H)).toBe(27);
  });
  it("1週間(T+168h)で停止", () => {
    expect(REMINDER_STOP_MS).toBe(168 * H);
    expect(nextActionReminderSlot(T, T + 168 * H - 1)).toBe(27);
    expect(nextActionReminderSlot(T, T + 168 * H)).toBeNull();
  });
  it("止まっていても取りこぼした回をまとめず、今の1回だけ", () => {
    // 6時間止まっていた → 3回分ではなく今の回の番号1つ
    expect(nextActionReminderSlot(T, T + 7 * H)).toBe(3);
  });
  it("時刻ありは T−5分から0回目", () => {
    expect(nextActionReminderSlot(T, T - 5 * M - 1, { timed: true })).toBeNull();
    expect(nextActionReminderSlot(T, T - 5 * M, { timed: true })).toBe(0);
    expect(nextActionReminderSlot(T, T + 2 * H, { timed: true })).toBe(1);
  });
});

describe("日本時間の今日と期限", () => {
  it("UTC 14:59 は日本時間の同じ日の23:59・UTC 15:00 で翌日", () => {
    expect(jstToday(new Date(Date.UTC(2026, 9, 1, 14, 59)))).toBe("2026-10-01");
    expect(jstToday(new Date(Date.UTC(2026, 9, 1, 15, 0)))).toBe("2026-10-02");
  });
  it("時刻なしの期限は予定日の 9:00(日本時間)", () => {
    // DB の date 列は UTC 0時の Date で返る
    expect(nextActionDeadline(new Date("2026-10-02T00:00:00.000Z"))).toBe(T);
  });
});

describe("時刻ありの期限(段階3)", () => {
  it("予定日＋時刻(日本時間)", () => {
    expect(nextActionDeadline(new Date("2026-10-02T00:00:00.000Z"), "15:00")).toBe(Date.parse("2026-10-02T15:00:00+09:00"));
    expect(nextActionDeadline(new Date("2026-10-02T00:00:00.000Z"), "00:05")).toBe(Date.parse("2026-10-02T00:05:00+09:00"));
  });
  it("時刻なし・形の崩れた時刻は 9:00", () => {
    for (const t of [null, undefined, "", "9:00", "24:00"]) {
      expect(nextActionDeadline(new Date("2026-10-02T00:00:00.000Z"), t)).toBe(T);
    }
  });
  it("時刻ありかどうか", () => {
    expect(isTimedNextAction("15:00")).toBe(true);
    expect(isTimedNextAction(null)).toBe(false);
    expect(isTimedNextAction("9:00")).toBe(false);
  });
});
