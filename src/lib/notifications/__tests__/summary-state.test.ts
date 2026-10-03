import { describe, it, expect } from "vitest";
import {
  EVENT_SEEN_TTL_MS,
  REMINDER_SEEN_TTL_MS,
  decideSummaryNotices,
  emptySummaryState,
  nextActionBody,
  nextActionReminderBody,
  parseSummaryState,
  registryJobBody,
  resetCursors,
  summaryQuery,
  type SummaryResponse,
} from "../summary-state";

const NOW = Date.parse("2026-10-02T03:00:00Z");
const res = (over: Partial<SummaryResponse> = {}): SummaryResponse => ({
  nextActions: { today: 0, overdue: 0, reminders: [] },
  inquiries: { open: 0, newKeys: [], cursor: "c1", cursorAt: 100 },
  registryJobs: { completed: [], cursor: "r1", cursorAt: 100 },
  ...over,
});

describe("次回対応の知らせ", () => {
  it("まだ見ていない回があれば1つにまとめて出す・同じ回は2回出さない", () => {
    const r = res({ nextActions: { today: 3, overdue: 1, reminders: [{ key: "k1", slot: 0 }, { key: "k2", slot: 4 }] } });
    const a = decideSummaryNotices(emptySummaryState(), r, NOW);
    expect(a.notices).toEqual([
      { kind: "next_action", tag: "next-action:reminder", title: "次回対応", body: "今日の次回対応が3件、期限切れが1件あります", url: "/home" },
    ]);
    expect(decideSummaryNotices(a.state, r, NOW + 60_000).notices).toEqual([]);
  });
  it("新しい回(期限の変更・担当の戻り・次の回)の印が現れたら出し直す", () => {
    const first = decideSummaryNotices(emptySummaryState(), res({ nextActions: { today: 1, overdue: 0, reminders: [{ key: "k1", slot: 0 }] } }), NOW);
    const next = decideSummaryNotices(first.state, res({ nextActions: { today: 1, overdue: 0, reminders: [{ key: "k1b", slot: 1 }] } }), NOW);
    expect(next.notices).toHaveLength(1);
  });
  it("時刻ありの5分前の回は「15:00 の次回対応が1件あります」(時刻ごとに件数・N5)", () => {
    const r = res({ nextActions: { today: 3, overdue: 0, reminders: [{ key: "t1", slot: 0, dueTime: "15:00" }, { key: "t2", slot: 0, dueTime: "15:00" }, { key: "t3", slot: 0, dueTime: "00:03" }] } });
    expect(decideSummaryNotices(emptySummaryState(), r, NOW).notices[0].body).toBe("00:03 の次回対応が1件、15:00 の次回対応が2件あります");
  });
  it("時刻ありの5分前と、ほかの回が同時に新しいときは両方を出す", () => {
    expect(nextActionReminderBody([{ dueTime: "15:00" }, {}], 2, 1)).toBe("15:00 の次回対応が1件あります。今日の次回対応が2件、期限切れが1件あります");
    expect(nextActionReminderBody([{}], 2, 0)).toBe("今日の次回対応が2件あります");
  });
  it("見た回は文言に入れない(新しい回だけで数える)", () => {
    const first = decideSummaryNotices(emptySummaryState(), res({ nextActions: { today: 1, overdue: 0, reminders: [{ key: "t1", slot: 0, dueTime: "15:00" }] } }), NOW);
    const next = decideSummaryNotices(first.state, res({ nextActions: { today: 2, overdue: 0, reminders: [{ key: "t1", slot: 0, dueTime: "15:00" }, { key: "t2", slot: 0, dueTime: "16:00" }] } }), NOW);
    expect(next.notices[0].body).toBe("16:00 の次回対応が1件あります");
  });
  it("文言は0件の側を省く", () => {
    expect(nextActionBody(2, 0)).toBe("今日の次回対応が2件あります");
    expect(nextActionBody(0, 1)).toBe("期限切れが1件あります");
    expect(nextActionBody(0, 0)).toBe("次回対応があります");
  });
  it("見る権限が無い(null)ときは何も出さない", () => {
    expect(decideSummaryNotices(emptySummaryState(), res({ nextActions: null }), NOW).notices).toEqual([]);
  });
});

describe("査定申込の知らせ", () => {
  it("初回は initialSeenKeys を見た扱いにする(初期化より前の申込を新着として出さない)", () => {
    const a = decideSummaryNotices(emptySummaryState(), res({ inquiries: { open: 1, newKeys: [], cursor: "c1", cursorAt: 100, initialSeenKeys: ["old"] } }), NOW);
    expect(a.notices).toEqual([]);
    const b = decideSummaryNotices(a.state, res({ inquiries: { open: 1, newKeys: ["old"], cursor: "c2", cursorAt: 200 } }), NOW);
    expect(b.notices).toEqual([]);
  });
  it("「1件完了＋1件新着」で件数が同じでも、新しい印があれば出す", () => {
    const a = decideSummaryNotices(emptySummaryState(), res({ inquiries: { open: 1, newKeys: ["x"], cursor: "c1", cursorAt: 100 } }), NOW);
    const b = decideSummaryNotices(a.state, res({ inquiries: { open: 1, newKeys: ["x", "y"], cursor: "c2", cursorAt: 200 } }), NOW);
    expect(b.notices).toEqual([
      { kind: "inquiry_new", tag: "inquiry:new", title: "査定の申込", body: "新しい査定の申込が1件あります", url: "/properties/sale-dm/inquiries" },
    ]);
  });
  it("カーソルは新しい方を残す(ほかのタブが先に進めていたら戻さない)", () => {
    const s = { ...emptySummaryState(), inquiry: { cursor: "newer", cursorAt: 500, seen: {} } };
    const b = decideSummaryNotices(s, res({ inquiries: { open: 0, newKeys: [], cursor: "older", cursorAt: 300 } }), NOW);
    expect(b.state.inquiry.cursor).toBe("newer");
    const c = decideSummaryNotices(s, res({ inquiries: { open: 0, newKeys: [], cursor: "newest", cursorAt: 600 } }), NOW);
    expect(c.state.inquiry.cursor).toBe("newest");
  });
  it("見られなくなった・通知 OFF になったらカーソルを捨てる(また ON にしたとき溜まった分をまとめて出さない)", () => {
    const s = { ...emptySummaryState(), inquiry: { cursor: "c", cursorAt: 1, seen: {} } };
    expect(decideSummaryNotices(s, res({ inquiries: null }), NOW).state.inquiry.cursor).toBeNull();
    expect(decideSummaryNotices(s, res({ inquiries: { open: 2, newKeys: null, cursor: null, cursorAt: null } }), NOW).state.inquiry.cursor).toBeNull();
  });
});

describe("謄本の一括取得の知らせ", () => {
  it("ジョブごとに出す・押すとジョブの画面・同じジョブは2回出さない", () => {
    const job = { key: "j1", href: "/properties/registry-fetch/x", done: 12, failed: 1, skipped: 2, chargedButFailed: 1 };
    const a = decideSummaryNotices(emptySummaryState(), res({ registryJobs: { completed: [job], cursor: "r", cursorAt: 1 } }), NOW);
    expect(a.notices).toEqual([
      { kind: "registry_job_done", tag: "registry-job:j1", title: "謄本の一括取得", body: "謄本の一括取得が完了しました（成功12件・失敗1件・要手動2件・要確認1件）", url: "/properties/registry-fetch/x" },
    ]);
    expect(decideSummaryNotices(a.state, res({ registryJobs: { completed: [job], cursor: "r", cursorAt: 1 } }), NOW).notices).toEqual([]);
  });
  it("0件の区分は省き、要確認は必ず出す", () => {
    expect(registryJobBody({ done: 1, failed: 0, skipped: 0, chargedButFailed: 0 })).toBe("謄本の一括取得が完了しました（成功1件）");
    expect(registryJobBody({ done: 0, failed: 0, skipped: 0, chargedButFailed: 2 })).toBe("謄本の一括取得が完了しました（要確認2件）");
  });
});

describe("保存値", () => {
  it("往復でき、期限を過ぎた印は捨てる(申込・謄本は1日・次回対応は1週間)", () => {
    const s = emptySummaryState();
    s.inquiry = { cursor: "c", cursorAt: 1, seen: { a: NOW - EVENT_SEEN_TTL_MS, b: NOW - 1 } };
    s.nextAction.seen = { r1: NOW - REMINDER_SEEN_TTL_MS, r2: NOW - EVENT_SEEN_TTL_MS - 1 };
    const back = parseSummaryState(JSON.stringify(s), NOW);
    expect(back.inquiry.seen).toEqual({ b: NOW - 1 });
    expect(back.nextAction.seen).toEqual({ r2: NOW - EVENT_SEEN_TTL_MS - 1 });
    expect(back.inquiry.cursor).toBe("c");
  });
  it("壊れた値・別の版は空から", () => {
    expect(parseSummaryState("{", NOW)).toEqual(emptySummaryState());
    expect(parseSummaryState(JSON.stringify({ v: 2 }), NOW)).toEqual(emptySummaryState());
  });
  it("問い合わせにはあるカーソルだけ付ける・400 のあとはカーソルを捨てる", () => {
    const s = { ...emptySummaryState(), inquiry: { cursor: "a+b", cursorAt: 1, seen: {} } };
    expect(summaryQuery(emptySummaryState())).toBe("");
    expect(summaryQuery(s)).toBe("inquiryCursor=a%2Bb");
    expect(summaryQuery(resetCursors(s))).toBe("");
  });
  it("400 のコードで、読めなかった区分のカーソルだけを捨てる(もう片方は続きから)", () => {
    const s = { ...emptySummaryState(), inquiry: { cursor: "i", cursorAt: 1, seen: {} }, registry: { cursor: "r", cursorAt: 1, seen: {} } };
    expect(summaryQuery(resetCursors(s, "BAD_INQUIRY_CURSOR"))).toBe("registryCursor=r");
    expect(summaryQuery(resetCursors(s, "BAD_REGISTRY_CURSOR"))).toBe("inquiryCursor=i");
    expect(summaryQuery(resetCursors(s, null))).toBe("");
  });
  it("保存値に生の ID・期限を置かない(印とカーソルの不透明な値・時刻だけ)", () => {
    const a = decideSummaryNotices(
      emptySummaryState(),
      res({ registryJobs: { completed: [{ key: "j1", href: "/properties/registry-fetch/00000000-0000-4000-8000-000000000001", done: 1, failed: 0, skipped: 0, chargedButFailed: 0 }], cursor: "r", cursorAt: 1 } }),
      NOW,
    );
    expect(JSON.stringify(a.state)).not.toContain("00000000-0000-4000");
  });
});
