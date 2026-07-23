/**
 * 完成待ち候補の経過日数表示 (放置の可視化) の純ロジック検証。
 */
import { describe, it, expect } from "vitest";
import {
  describeCandidateAge,
  CANDIDATE_STALE_DAYS,
  CANDIDATE_LIST_LIMIT,
} from "@/lib/field-survey-candidate-util";

const NOW = new Date("2026-07-23T12:00:00+09:00");

describe("describeCandidateAge", () => {
  it("当日は「今日」", () => {
    const r = describeCandidateAge("2026-07-23T09:00:00+09:00", NOW);
    expect(r).toEqual({ label: "今日", days: 0, stale: false });
  });

  it("前日は「昨日」", () => {
    const r = describeCandidateAge("2026-07-22T23:00:00+09:00", NOW);
    expect(r.label).toBe("昨日");
    expect(r.days).toBe(1);
    expect(r.stale).toBe(false);
  });

  it("2日以上は「N日前」", () => {
    expect(describeCandidateAge("2026-07-20T12:00:00+09:00", NOW).label).toBe(
      "3日前",
    );
  });

  it("しきい値 (7日) 以上で stale=true (放置の強調)", () => {
    expect(CANDIDATE_STALE_DAYS).toBe(7);
    const six = describeCandidateAge("2026-07-17T12:00:00+09:00", NOW);
    expect(six.days).toBe(6);
    expect(six.stale).toBe(false);
    const seven = describeCandidateAge("2026-07-16T12:00:00+09:00", NOW);
    expect(seven.days).toBe(7);
    expect(seven.stale).toBe(true);
  });

  it("未来日時 (時計ズレ) は「今日」に丸める", () => {
    const r = describeCandidateAge("2026-07-24T12:00:00+09:00", NOW);
    expect(r.days).toBe(0);
    expect(r.label).toBe("今日");
  });

  it("不正な日時は空 label で例外を出さない", () => {
    const r = describeCandidateAge("not-a-date", NOW);
    expect(r).toEqual({ label: "", days: 0, stale: false });
  });
});

describe("CANDIDATE_LIST_LIMIT", () => {
  it("一覧の取得上限は 200 (超過時は古い候補が表示されない → UI が警告を出す)", () => {
    expect(CANDIDATE_LIST_LIMIT).toBe(200);
  });
});
