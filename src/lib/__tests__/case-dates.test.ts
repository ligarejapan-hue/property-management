/**
 * 契約予定日・決済予定日(案件ステータス 契約予定/契約完了/決済完了 のときだけ出る欄)の決まり。
 * 2026-10-23 発注者指示: 「8,9,10 のステップに進んだ際に契約予定日、完了予定日の入力画面、表示を
 * 出して欲しい。契約予定日が未定の場合もあるのでそれも踏まえて」→ 欄の名前は「決済予定日」。
 */
import { describe, it, expect } from "vitest";
import {
  CASE_DATE_FIELDS,
  showsCaseDates,
  caseDateLabels,
  dateOnlyString,
  parseDateOnly,
  formatDateOnlyJa,
  caseDateNotice,
  caseDatesSummary,
  todayDateOnly,
} from "../case-dates";
import { CASE_STATUS_VALUES } from "../property-types";

describe("showsCaseDates(欄を出すステータス)", () => {
  it("契約予定・契約完了・決済完了のときだけ出す", () => {
    const shown = CASE_STATUS_VALUES.filter((s) => showsCaseDates(s));
    expect(shown).toEqual(["contract_planned", "contracted", "sold"]);
  });
  it("やめた古い値・未知の値では出さない", () => {
    expect(showsCaseDates("owner_contacted")).toBe(false);
    expect(showsCaseDates("")).toBe(false);
  });
});

describe("caseDateLabels(進み具合で見出しが変わる・値は同じ2欄)", () => {
  it("契約予定=契約予定日/決済予定日", () => {
    expect(caseDateLabels("contract_planned")).toEqual({ contract: "契約予定日", settlement: "決済予定日" });
  });
  it("契約完了=契約日/決済予定日", () => {
    expect(caseDateLabels("contracted")).toEqual({ contract: "契約日", settlement: "決済予定日" });
  });
  it("決済完了=契約日/決済日", () => {
    expect(caseDateLabels("sold")).toEqual({ contract: "契約日", settlement: "決済日" });
  });
  it("それ以外(変更履歴の見出しなど)は契約予定日/決済予定日", () => {
    expect(caseDateLabels("new_case")).toEqual({ contract: "契約予定日", settlement: "決済予定日" });
  });
  it("保存する欄は2つだけ", () => {
    expect([...CASE_DATE_FIELDS]).toEqual(["contractPlannedOn", "settlementPlannedOn"]);
  });
});

describe("dateOnlyString / parseDateOnly(DB の DATE 列と YYYY-MM-DD の行き来)", () => {
  it("Date(UTC の 0 時)→ YYYY-MM-DD", () => {
    expect(dateOnlyString(new Date(Date.UTC(2026, 10, 15)))).toBe("2026-11-15");
  });
  it("JSON 経由の ISO 文字列 → 先頭の日付だけ", () => {
    expect(dateOnlyString("2026-11-15T00:00:00.000Z")).toBe("2026-11-15");
    expect(dateOnlyString("2026-11-15")).toBe("2026-11-15");
  });
  it("空・壊れた値は null", () => {
    expect(dateOnlyString(null)).toBeNull();
    expect(dateOnlyString(undefined)).toBeNull();
    expect(dateOnlyString("")).toBeNull();
    expect(dateOnlyString("11/15")).toBeNull();
    expect(dateOnlyString(new Date("x"))).toBeNull();
  });
  it("parseDateOnly は暦にある日だけ UTC の 0 時の Date にする", () => {
    expect(parseDateOnly("2026-11-15")?.toISOString()).toBe("2026-11-15T00:00:00.000Z");
    expect(parseDateOnly("2026-02-30")).toBeNull();
    expect(parseDateOnly("2026-13-01")).toBeNull();
    expect(parseDateOnly("20261115")).toBeNull();
    expect(parseDateOnly("")).toBeNull();
  });
});

describe("formatDateOnlyJa(画面の表示)", () => {
  it("年つき・年なし", () => {
    expect(formatDateOnlyJa("2026-11-15")).toBe("2026/11/15");
    expect(formatDateOnlyJa("2026-11-05", { withYear: false })).toBe("11/5");
  });
  it("未定(null)は「未定」", () => {
    expect(formatDateOnlyJa(null)).toBe("未定");
    expect(formatDateOnlyJa(null, { withYear: false })).toBe("未定");
  });
});

describe("caseDateNotice(予定日の前後の知らせ)", () => {
  const today = "2026-10-23";
  it("契約予定: 契約予定日が先なら「あと N 日」", () => {
    expect(caseDateNotice("contract_planned", "2026-11-15", null, today)).toEqual({ kind: "soon", text: "契約まであと 23 日" });
  });
  it("契約予定: 当日は「今日」", () => {
    expect(caseDateNotice("contract_planned", "2026-10-23", null, today)).toEqual({ kind: "soon", text: "契約は今日" });
  });
  it("契約予定: 過ぎていてまだ進んでいなければ「N 日過ぎています」", () => {
    expect(caseDateNotice("contract_planned", "2026-10-20", "2026-12-20", today)).toEqual({ kind: "overdue", text: "契約予定日を 3 日過ぎています" });
  });
  it("契約予定: 未定なら知らせない", () => {
    expect(caseDateNotice("contract_planned", null, "2026-12-20", today)).toBeNull();
  });
  it("契約完了: 決済予定日で見る", () => {
    expect(caseDateNotice("contracted", "2026-10-01", "2026-12-20", today)).toEqual({ kind: "soon", text: "決済まであと 58 日" });
    expect(caseDateNotice("contracted", "2026-10-01", "2026-10-22", today)).toEqual({ kind: "overdue", text: "決済予定日を 1 日過ぎています" });
    expect(caseDateNotice("contracted", "2026-10-01", null, today)).toBeNull();
  });
  it("決済完了・それ以外のステータスは知らせない", () => {
    expect(caseDateNotice("sold", "2026-10-01", "2026-10-20", today)).toBeNull();
    expect(caseDateNotice("on_sale", "2026-10-01", "2026-10-20", today)).toBeNull();
  });
});

describe("caseDatesSummary(一覧の2行目)", () => {
  it("8〜10 の物件だけ「契約 11/15 ・ 決済 未定」の形", () => {
    expect(caseDatesSummary("contract_planned", "2026-11-15", null)).toBe("契約 11/15 ・ 決済 未定");
    expect(caseDatesSummary("sold", "2026-09-30", "2026-10-20")).toBe("契約 9/30 ・ 決済 10/20");
  });
  it("それ以外は null(行は今のまま)", () => {
    expect(caseDatesSummary("on_sale", "2026-11-15", "2026-12-20")).toBeNull();
  });
});

describe("todayDateOnly(端末の今日)", () => {
  it("端末の時刻で YYYY-MM-DD", () => {
    expect(todayDateOnly(new Date(2026, 9, 23, 23, 30))).toBe("2026-10-23");
    expect(todayDateOnly(new Date(2026, 0, 5, 0, 10))).toBe("2026-01-05");
  });
});
