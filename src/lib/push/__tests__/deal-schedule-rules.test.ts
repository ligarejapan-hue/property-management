import { describe, expect, it } from "vitest";
import { DELIVERY_KINDS, dealSchedulePayload, dealScheduleRefKey, parseDealScheduleRefKey } from "../deliveries/rules";
import { dealScheduleBody, decideSummaryNotices, emptySummaryState, parseSummaryState, type SummaryResponse } from "@/lib/notifications/summary-state";

const ID = "33333333-3333-4333-8333-333333333333";

describe("段取りの通知の決まりごと", () => {
  it("種類に deal_schedule がある", () => expect(DELIVERY_KINDS).toContain("deal_schedule"));
  it("ref_key に中身を入れず、読み戻せる", () => {
    const k = dealScheduleRefKey(ID, "2026-11-03", "tomorrow", "2026-11-02");
    expect(k).toBe(`deal_schedule:${ID}:2026-11-03:tomorrow:2026-11-02`);
    expect(parseDealScheduleRefKey(k)).toEqual({ id: ID, dueDate: "2026-11-03", slot: "tomorrow", today: "2026-11-02" });
  });
  it("知らない対象・崩れた形は読まない", () => {
    expect(parseDealScheduleRefKey(`deal_schedule:${ID}:2026-11-03:later:2026-11-02`)).toBeNull();
    expect(parseDealScheduleRefKey("next_action:x")).toBeNull();
  });
  it("日が変われば別の件(期限超過は毎朝1回)", () => {
    expect(dealScheduleRefKey(ID, "2026-10-01", "overdue", "2026-11-02")).not.toBe(dealScheduleRefKey(ID, "2026-10-01", "overdue", "2026-11-03"));
  });
  it("本文は件数だけ", () => {
    expect(dealScheduleBody({ today: 1, tomorrow: 2, overdue: 3 })).toBe("今日の段取りが1件、明日の段取りが2件、期限超過が3件あります");
    expect(dealScheduleBody({ today: 0, tomorrow: 0, overdue: 3 })).toBe("期限超過が3件あります");
    const p = dealSchedulePayload("b", { today: 1, tomorrow: 0, overdue: 0 });
    expect(p).toEqual({ b: "b", title: "決済までの段取り", body: "今日の段取りが1件あります", url: "/home", tag: "deal-schedule:morning" });
  });
});

describe("画面を開いている間の知らせ", () => {
  const res = (keys: string[], overdue = 0): SummaryResponse => ({
    nextActions: null, inquiries: null, registryJobs: { completed: [], cursor: "c", cursorAt: 1 }, dealSchedule: { today: keys.length, tomorrow: 0, overdue, reminders: keys.map((key) => ({ key })) },
  });
  it("新しい印があれば1つにまとめて知らせ、2回目は知らせない", () => {
    const a = decideSummaryNotices(emptySummaryState(), res(["k1", "k2"]), 1000);
    expect(a.notices.filter((n) => n.kind === "deal_schedule")).toHaveLength(1);
    const b = decideSummaryNotices(a.state, res(["k1", "k2"]), 2000);
    expect(b.notices.filter((n) => n.kind === "deal_schedule")).toHaveLength(0);
  });
  it("古いサーバー(欄が無い)でも壊れない・保存値に欄が無くても読める", () => {
    const r = res([]);
    delete r.dealSchedule;
    expect(decideSummaryNotices(emptySummaryState(), r, 1000).notices.filter((n) => n.kind === "deal_schedule")).toEqual([]);
    expect(parseSummaryState(JSON.stringify({ v: 1 }), 1000).dealSchedule).toEqual({ seen: {} });
  });
});
