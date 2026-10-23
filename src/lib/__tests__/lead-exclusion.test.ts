import { describe, it, expect } from "vitest";
import {
  LEAD_EXCLUSION_OVERDUE_DAYS,
  LEAD_EXCLUSION_FILTER_OPTIONS,
  buildLeadExclusionWhere,
  jstTodayDateOnly,
  leadExclusionBadge,
  leadExclusionElapsedDays,
  normalizeLeadExclusionPatch,
  shiftDateOnly,
  showsLeadExclusionBlock,
} from "@/lib/lead-exclusion";

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe("jstTodayDateOnly(JST の暦日)", () => {
  it("UTC 14:59:59 は JST 同じ日の 23:59:59・UTC 15:00 で JST の翌日になる", () => {
    expect(jstTodayDateOnly(new Date("2026-10-24T14:59:59.999Z"))).toBe("2026-10-24");
    expect(jstTodayDateOnly(new Date("2026-10-24T15:00:00.000Z"))).toBe("2026-10-25");
  });
  it("JST 0時ちょうど(UTC 前日 15:00)は JST の当日", () => {
    expect(jstTodayDateOnly(new Date("2026-12-31T15:00:00.000Z"))).toBe("2027-01-01");
  });
});

describe("shiftDateOnly", () => {
  it("月・年をまたぐ", () => {
    expect(shiftDateOnly("2026-03-03", -7)).toBe("2026-02-24");
    expect(shiftDateOnly("2027-01-03", -7)).toBe("2026-12-27");
  });
  it("壊れた日付は null", () => {
    expect(shiftDateOnly("2026-02-30", -7)).toBeNull();
  });
});

describe("leadExclusionElapsedDays", () => {
  it("申請した日=0日・翌日=1日", () => {
    expect(leadExclusionElapsedDays("2026-10-24", "2026-10-24")).toBe(0);
    expect(leadExclusionElapsedDays("2026-10-23", "2026-10-24")).toBe(1);
  });
  it("申請日なし・壊れた日付は null", () => {
    expect(leadExclusionElapsedDays(null, "2026-10-24")).toBeNull();
    expect(leadExclusionElapsedDays("x", "2026-10-24")).toBeNull();
  });
});

describe("leadExclusionBadge(一覧の札)", () => {
  const today = "2026-10-24";
  it("しきい値は7日(名前つきの定数)", () => {
    expect(LEAD_EXCLUSION_OVERDUE_DAYS).toBe(7);
  });
  it("6日=琥珀・7日/8日=赤で「運営に確認」", () => {
    expect(leadExclusionBadge("requested", "2026-10-18", today)).toEqual({ text: "除外申請中 6日", intent: "warning" });
    expect(leadExclusionBadge("requested", "2026-10-17", today)).toEqual({
      text: "除外申請中 7日・運営に確認",
      intent: "error",
    });
    expect(leadExclusionBadge("requested", "2026-10-16", today)).toEqual({
      text: "除外申請中 8日・運営に確認",
      intent: "error",
    });
  });
  it("当日は 0日・未来の日付は 0日扱い", () => {
    expect(leadExclusionBadge("requested", today, today)?.text).toBe("除外申請中 0日");
    expect(leadExclusionBadge("requested", "2026-10-30", today)?.text).toBe("除外申請中 0日");
  });
  it("JST の日付の切り替わりで N が増える(同じ申請日・UTC 14:59 と 15:00)", () => {
    const before = jstTodayDateOnly(new Date("2026-10-24T14:59:59Z"));
    const after = jstTodayDateOnly(new Date("2026-10-24T15:00:00Z"));
    expect(leadExclusionBadge("requested", "2026-10-18", before)?.text).toBe("除外申請中 6日");
    expect(leadExclusionBadge("requested", "2026-10-18", after)?.text).toBe("除外申請中 7日・運営に確認");
  });
  it("申請日の無い申請中は日数なし", () => {
    expect(leadExclusionBadge("requested", null, today)).toEqual({ text: "除外申請中", intent: "warning" });
  });
  it("除外された=除外済・認められなかった=除外不可・なし/不明な値=null", () => {
    expect(leadExclusionBadge("approved", "2026-10-01", today)).toEqual({ text: "除外済", intent: "neutral" });
    expect(leadExclusionBadge("rejected", null, today)).toEqual({ text: "除外不可", intent: "neutral" });
    expect(leadExclusionBadge(null, null, today)).toBeNull();
    expect(leadExclusionBadge("bogus", "2026-10-01", today)).toBeNull();
  });
});

describe("buildLeadExclusionWhere(一覧・CSV の絞り込み)", () => {
  const today = "2026-10-24";
  it("すべて(未指定)=絞らない", () => {
    expect(buildLeadExclusionWhere(undefined, today)).toBeNull();
  });
  it("申請中・除外された・認められなかった=状態だけ", () => {
    expect(buildLeadExclusionWhere("requested", today)).toEqual({ leadExclusionStatus: "requested" });
    expect(buildLeadExclusionWhere("approved", today)).toEqual({ leadExclusionStatus: "approved" });
    expect(buildLeadExclusionWhere("rejected", today)).toEqual({ leadExclusionStatus: "rejected" });
  });
  it("申請中で7日以上=申請した日が今日の7日前以前(7日=入る・6日=入らない)", () => {
    const w = buildLeadExclusionWhere("requested_overdue", today) as {
      leadExclusionStatus: string;
      leadExclusionRequestedAt: { lte: Date };
    };
    expect(w.leadExclusionStatus).toBe("requested");
    expect(w.leadExclusionRequestedAt.lte.toISOString()).toBe("2026-10-17T00:00:00.000Z");
    // 札の判定と境界が一致する(7日=赤・6日=琥珀)
    expect(D("2026-10-17") <= w.leadExclusionRequestedAt.lte).toBe(true);
    expect(leadExclusionBadge("requested", "2026-10-17", today)?.intent).toBe("error");
    expect(D("2026-10-18") <= w.leadExclusionRequestedAt.lte).toBe(false);
    expect(leadExclusionBadge("requested", "2026-10-18", today)?.intent).toBe("warning");
  });
  it("選択肢の文言は定数から作る", () => {
    expect(LEAD_EXCLUSION_FILTER_OPTIONS.map((o) => o.label)).toEqual([
      "申請中",
      "申請中で7日以上",
      "除外された",
      "認められなかった",
    ]);
  });
});

describe("showsLeadExclusionBlock(詳細で最初から出すか)", () => {
  it("一括査定 or 状態あり=出す・それ以外=畳む", () => {
    expect(showsLeadExclusionBlock("bulk_assessment", null)).toBe(true);
    expect(showsLeadExclusionBlock("web_inquiry", "approved")).toBe(true);
    expect(showsLeadExclusionBlock("web_inquiry", null)).toBe(false);
    expect(showsLeadExclusionBlock(null, null)).toBe(false);
  });
});

describe("normalizeLeadExclusionPatch(保存する値)", () => {
  const today = "2026-10-24";
  const empty = { leadExclusionRequestedAt: null, leadExclusionDecidedAt: null };
  it("何も送られていなければ何も書かない", () => {
    expect(normalizeLeadExclusionPatch(empty, {}, today)).toEqual({});
  });
  it("申請中にして日付が無ければ今日・結果の日は消す", () => {
    expect(normalizeLeadExclusionPatch(empty, { leadExclusionStatus: "requested" }, today)).toEqual({
      leadExclusionStatus: "requested",
      leadExclusionRequestedAt: D(today),
      leadExclusionDecidedAt: null,
    });
  });
  it("申請中にして日付を指定したらその日", () => {
    expect(
      normalizeLeadExclusionPatch(
        empty,
        { leadExclusionStatus: "requested", leadExclusionRequestedAt: D("2026-10-20") },
        today,
      ),
    ).toEqual({ leadExclusionStatus: "requested", leadExclusionRequestedAt: D("2026-10-20"), leadExclusionDecidedAt: null });
  });
  it("除外された/認められなかった: 結果の日が無ければ今日・申請した日は残す", () => {
    const cur = { leadExclusionRequestedAt: D("2026-10-15"), leadExclusionDecidedAt: null };
    expect(normalizeLeadExclusionPatch(cur, { leadExclusionStatus: "approved" }, today)).toEqual({
      leadExclusionStatus: "approved",
      leadExclusionDecidedAt: D(today),
    });
    expect(
      normalizeLeadExclusionPatch(cur, { leadExclusionStatus: "rejected", leadExclusionDecidedAt: D("2026-10-22") }, today),
    ).toEqual({ leadExclusionStatus: "rejected", leadExclusionDecidedAt: D("2026-10-22") });
  });
  it("なしに戻したら2つの日付も消す", () => {
    const cur = { leadExclusionRequestedAt: D("2026-10-15"), leadExclusionDecidedAt: D("2026-10-20") };
    expect(normalizeLeadExclusionPatch(cur, { leadExclusionStatus: null }, today)).toEqual({
      leadExclusionStatus: null,
      leadExclusionRequestedAt: null,
      leadExclusionDecidedAt: null,
    });
  });
  it("日付だけ直す送り方はそのまま", () => {
    expect(normalizeLeadExclusionPatch(empty, { leadExclusionRequestedAt: D("2026-10-10") }, today)).toEqual({
      leadExclusionRequestedAt: D("2026-10-10"),
    });
  });
});
