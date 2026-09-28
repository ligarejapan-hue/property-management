import { describe, it, expect } from "vitest";
import { buildPropertyTimeline, countInquiries, countsFromGroups, TIMELINE_LIMIT } from "@/lib/agent-inquiry/timeline";

const d = (s: string) => new Date(s);
const inq = (over: Record<string, unknown>) => ({
  id: "i", kind: "viewing", receivedAt: d("2026-09-20T00:00:00Z"), status: "open",
  agent: { companyName: "○○不動産" }, contactName: "田中", viewings: [], ...over,
}) as never;

describe("物件の時系列(新しい順)", () => {
  it("内見は予定日時で1行ずつ・それ以外は受けた日時・取り消しは印付き・日程未定は受けた日時", () => {
    const t = buildPropertyTimeline([
      inq({ id: "a", kind: "ad_permission", receivedAt: d("2026-09-20T00:40:00Z") }),
      inq({ id: "v", receivedAt: d("2026-09-21T00:00:00Z"), viewings: [
        { id: "v1", scheduledAt: d("2026-10-02T05:00:00Z"), viewingType: "guided", canceledAt: null, attendant: { name: "佐藤" }, resultNote: null },
        { id: "v2", scheduledAt: d("2026-09-25T06:30:00Z"), viewingType: "preview", canceledAt: d("2026-09-24T00:00:00Z"), attendant: null, resultNote: null },
        { id: "v3", scheduledAt: null, viewingType: "guided", canceledAt: null, attendant: null, resultNote: null },
      ] }),
    ]);
    expect(t.map((e) => [e.key, e.at.toISOString(), e.canceled])).toEqual([
      ["viewing:v1", "2026-10-02T05:00:00.000Z", false],
      ["viewing:v2", "2026-09-25T06:30:00.000Z", true],
      ["viewing:v3", "2026-09-21T00:00:00.000Z", false],
      ["inquiry:a", "2026-09-20T00:40:00.000Z", false],
    ]);
    expect(t[2].unscheduled).toBe(true);
    expect(t[0].attendantName).toBe("佐藤");
  });
  it("上限は並べた後にかける=古く受けた反響の新しい内見の予定も残る", () => {
    const many = Array.from({ length: TIMELINE_LIMIT + 5 }, (_, n) =>
      inq({ id: `r${n}`, kind: "ad_permission", receivedAt: new Date(Date.UTC(2026, 5, 1) + n * 60000) }));
    const old = inq({ id: "old", receivedAt: d("2020-01-01T00:00:00Z"), viewings: [
      { id: "future", scheduledAt: d("2027-01-01T00:00:00Z"), viewingType: "guided", canceledAt: null },
    ] });
    const t = buildPropertyTimeline([...many, old]);
    expect(t).toHaveLength(TIMELINE_LIMIT);
    expect(t[0].key).toBe("viewing:future");
  });
  it("内見の予定が無い内見の反響は反響として1行", () => {
    expect(buildPropertyTimeline([inq({ id: "x" })]).map((e) => e.key)).toEqual(["inquiry:x"]);
  });
});

describe("件数", () => {
  it("案内/下見は取り消しを数えない", () => {
    const c = countInquiries([
      inq({ viewings: [
        { id: "1", scheduledAt: null, viewingType: "guided", canceledAt: null },
        { id: "2", scheduledAt: null, viewingType: "preview", canceledAt: null },
        { id: "3", scheduledAt: null, viewingType: "guided", canceledAt: d("2026-09-01T00:00:00Z") },
      ] }),
      inq({ kind: "material_request" }),
      inq({ kind: "ad_permission" }),
    ]);
    expect(c).toEqual({ total: 3, guided: 1, preview: 1, materialRequest: 1, adPermission: 1 });
  });
});

describe("件数は集計クエリの結果から(500件の時系列の上限に左右されない・@codex #454 P2)", () => {
  it("用件ごと・内見の種別ごとの件数をまとめる", () => {
    expect(countsFromGroups(
      [{ kind: "viewing", _count: { _all: 700 } }, { kind: "material_request", _count: { _all: 3 } }, { kind: "ad_permission", _count: { _all: 2 } }],
      [{ viewingType: "guided", _count: { _all: 650 } }, { viewingType: "preview", _count: { _all: 40 } }],
    )).toEqual({ total: 705, guided: 650, preview: 40, materialRequest: 3, adPermission: 2 });
  });
  it("何も無ければ 0", () => {
    expect(countsFromGroups([], [])).toEqual({ total: 0, guided: 0, preview: 0, materialRequest: 0, adPermission: 0 });
  });
});
