/**
 * 歩いた道筋（線）の API (`GET /api/field-survey/coverage/tracks`) の振る舞い固定。
 *
 * 業務背景: 面（マス）の色だけでは、マスが道より広く、点の間もつながないので
 * 「実際に歩いた筋」が出ない。線はそれを補う（ユーザー指摘 2026-07-29）。
 *
 * ⚠この API は cells と違い**生の座標を返す**。そのため
 *   ①誰の・いつ・どの巡回かを返さない
 *   ②誰の・いつ・どの巡回かを返さない
 *   ③終了した巡回だけを対象にする
 * の3つで境界を作っている。どれが崩れても同僚の追跡になるので表明で固定する。
 *
 * vitest は env=node。prisma / api-helpers / permissions の mock は
 * field-survey-coverage-route.test.ts に合わせる。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {
    constructor(input: string | URL | Request, init?: RequestInit) {
      super(input, init);
    }
  }
  return { NextRequest: MockNextRequest };
});

vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(),
    getUserPermissions: vi.fn(),
    apiResponse: vi.fn((data: unknown, status = 200) =>
      Response.json(data, { status }),
    ),
    handleApiError: vi.fn((error: unknown) => {
      if (error instanceof MockApiError) {
        return Response.json(
          { error: { message: error.message, code: error.code } },
          { status: error.status },
        );
      }
      if (
        error &&
        typeof error === "object" &&
        "issues" in error &&
        Array.isArray((error as { issues: unknown[] }).issues)
      ) {
        return Response.json(
          { error: { message: "validation", code: "VALIDATION_ERROR" } },
          { status: 422 },
        );
      }
      return Response.json(
        { error: { message: "Server error", code: "INTERNAL_ERROR" } },
        { status: 500 },
      );
    }),
  };
});

// 本物と同じ判定をする spy（常に true だと「read だけで通る」の表明が空振りする）
vi.mock("@/lib/permissions", () => ({
  hasPermission: vi.fn(
    (
      permissions: Array<{ resource: string; action: string; granted: boolean }>,
      resource: string,
      action: string,
    ) =>
      permissions.find((p) => p.resource === resource && p.action === action)
        ?.granted ?? false,
  ),
}));

vi.mock("@/lib/prisma", () => ({
  default: { $queryRaw: vi.fn() },
}));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import {
  COVERAGE_TRACK_POINT_BUDGET,
  COVERAGE_TRACK_SESSION_LIMIT,
} from "@/lib/field-survey-tracks";
import { GET } from "@/app/api/field-survey/coverage/tracks/route";

const fieldUser = { id: "u-field", email: "f@x", name: "現地", role: "field_staff" };
/** 線を見るのに必要な権限（read だけでは足りない）。 */
const readAll = [
  { resource: "field_survey", action: "read", granted: true },
  { resource: "field_survey", action: "read_all", granted: true },
];
/** manage でも通る（既存の track-points と同じ境界）。 */
const manage = [
  { resource: "field_survey", action: "read", granted: true },
  { resource: "field_survey", action: "manage", granted: true },
];
/** 現地スタッフの既定（seed）。read はあるが read_all は無い。 */
const readOnly = [{ resource: "field_survey", action: "read", granted: true }];
const otherResourceOnly = [
  { resource: "property", action: "read", granted: true },
];

const BBOX = "north=35.698&south=35.68&east=139.78&west=139.76";

function makeReq(qs = `${BBOX}&days=365`) {
  return new Request(
    `http://x/api/field-survey/coverage/tracks?${qs}`,
  ) as unknown as import("next/server").NextRequest;
}

function rawCall(index: number) {
  const call = (prisma.$queryRaw as unknown as Mock).mock.calls[index];
  if (!call) return undefined;
  const [strings, ...values] = call as [string[], ...unknown[]];
  return {
    sql: strings.join("?").replace(/\s+/g, " "),
    values,
  };
}

interface TrackBody {
  data: {
    days: number;
    thinStep: number;
    droppedTrips: number;
    truncated: boolean;
    droppedTripsExact: boolean;
    lineCount: number;
    pointCount: number;
    lines: { lat: number; lng: number }[][];
  };
}

/** id と点数だけの巡回候補行。 */
const sess = (id: string, pointCount: number) => ({ id, pointCount });
/**
 * 点の行。`at`（epoch ms）は**線の切り分け判定にだけ**使い、応答には出さない。
 * 既定は 10 秒刻みで、しきい値（2分 / 200m）に掛からない連続した点にする。
 */
let ptClock = 0;
const pt = (sessionId: string, lat: number, lng: number, at?: number) => ({
  sessionId,
  lat,
  lng,
  at: at ?? (ptClock += 10_000),
});

function mockQueries(sessions: unknown[], points: unknown[]) {
  (prisma.$queryRaw as unknown as Mock)
    .mockResolvedValueOnce(sessions)
    .mockResolvedValueOnce(points);
}

beforeEach(() => {
  ptClock = 0;
  vi.clearAllMocks();
  // ⚠clearAllMocks は mockResolvedValueOnce の待ち行列を消さない。
  // 消さないと、DB を呼ばなかったテスト（403 など）の残りが次のテストへ
  // 流れて、まったく別の失敗として現れる。
  (prisma.$queryRaw as unknown as Mock).mockReset();
  (getApiSession as unknown as Mock).mockResolvedValue(fieldUser);
  (getUserPermissions as unknown as Mock).mockResolvedValue(readOnly);
});

describe("1. 権限（歩いた道筋は全員が見られる）", () => {
  it("read_all があれば見られる", async () => {
    mockQueries([sess("s1", 3)], [pt("s1", 35.69, 139.77), pt("s1", 35.691, 139.771)]);
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
  });

  it("manage でも見られる（既存の track-points と同じ境界）", async () => {
    (getUserPermissions as unknown as Mock).mockResolvedValue(manage);
    mockQueries([sess("s1", 3)], [pt("s1", 35.69, 139.77), pt("s1", 35.691, 139.771)]);
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
  });

  it("read だけで見られる（発注者判断: 制限する必要のない情報）", async () => {
    // ⚠@codex #334 P1 は read_all を要求すべきと指摘したが、発注者判断で read
    // のまま通す。既定テンプレートでは現地担当が read_all を持たないため、
    // 要求すると「街を歩く当人だけが見られない」逆転が起きる。
    (getUserPermissions as unknown as Mock).mockResolvedValue(readOnly);
    mockQueries([sess("s1", 3)], [pt("s1", 35.69, 139.77), pt("s1", 35.691, 139.771)]);
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
  });

  it("巡回機能の権限が無ければ 403", async () => {
    (getUserPermissions as unknown as Mock).mockResolvedValue(otherResourceOnly);
    const res = await GET(makeReq());
    expect(res.status).toBe(403);
    // 権限が無い時は DB を触らない
    expect(prisma.$queryRaw as unknown as Mock).not.toHaveBeenCalled();
  });
});

describe("2. 返さないもの（勤怠の証拠にしない）", () => {
  it("誰の・いつ・どの巡回かを応答に含めない", async () => {
    mockQueries(
      [sess("s1", 2)],
      [pt("s1", 35.69, 139.77), pt("s1", 35.691, 139.771)],
    );
    const res = await GET(makeReq());
    const body = (await res.json()) as TrackBody;
    const json = JSON.stringify(body);
    // session id / 氏名 / 時刻のいずれも出さない
    expect(json).not.toContain("s1");
    expect(json).not.toMatch(/staff|userId|user_id|name|氏名/i);
    expect(json).not.toMatch(/recordedAt|recorded_at|startedAt|endedAt|At"/);
    // 線の形だけが返る
    expect(body.data.lines[0]?.[0]).toEqual({ lat: 35.69, lng: 139.77 });
  });

  it("生座標を返すので端末・プロキシに残さない (no-store)", async () => {
    mockQueries([sess("s1", 2)], [pt("s1", 35.68, 139.76), pt("s1", 35.6801, 139.7601)]);
    const res = await GET(makeReq());
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(res.headers.get("Cache-Control")).toContain("private");
  });

  it("終了した巡回だけを対象にする（進行中を含めると同僚を追跡できる）", async () => {
    mockQueries([], []);
    await GET(makeReq());
    expect(rawCall(0)?.sql).toContain("s.status::text = 'ended'");
  });
});

describe("3. 線が嘘にならないこと", () => {
  it("点の取得を表示範囲で切らない（切ると通っていない道を横切る直線が出る）", async () => {
    mockQueries([sess("s1", 4)], [pt("s1", 35.68, 139.76), pt("s1", 35.6801, 139.7601)]);
    await GET(makeReq());
    const points = rawCall(1);
    expect(points).toBeDefined();
    // 2本目のクエリ（点の取得）に bbox の条件を入れない
    expect(points?.sql).not.toContain("tp.lat >=");
    expect(points?.sql).not.toContain("tp.lng >=");
    // 1本目（対象の巡回を選ぶ方）には入っている
    expect(rawCall(0)?.sql).toContain("tp.lat >=");
  });

  it("点の取得にも期間の下限を掛ける（@codex #334 P2）", async () => {
    // 境をまたぐ巡回は「最近の点が1つでもある」だけで候補に入る。掛けないと
    // 「直近1年」の線に1年より前の座標が混ざり、面の色と期間が食い違う。
    mockQueries([sess("s1", 4)], [pt("s1", 35.68, 139.76), pt("s1", 35.6801, 139.7601)]);
    await GET(makeReq(`${BBOX}&days=365`));
    expect(rawCall(1)?.sql).toContain("AT TIME ZONE 'UTC'");
  });

  it("点が1つしかない巡回は線にしない", async () => {
    mockQueries(
      [sess("a", 1), sess("b", 2)],
      [pt("a", 35.68, 139.76), pt("b", 35.69, 139.77), pt("b", 35.6901, 139.7701)],
    );
    const res = await GET(makeReq());
    const body = (await res.json()) as TrackBody;
    expect(body.data.lineCount).toBe(1);
    expect(body.data.lines[0]).toHaveLength(2);
  });

  it("巡回ごとに線を分ける（別の巡回を1本につなげない）", async () => {
    mockQueries(
      [sess("a", 2), sess("b", 2)],
      [
        pt("a", 35.68, 139.76),
        pt("a", 35.6801, 139.7601),
        pt("b", 35.69, 139.77),
        pt("b", 35.6901, 139.7701),
      ],
    );
    const res = await GET(makeReq());
    const body = (await res.json()) as TrackBody;
    expect(body.data.lineCount).toBe(2);
    expect(body.data.pointCount).toBe(4);
  });

  it("間引きは巡回内の通し番号の剰余で行い、最初と最後は必ず残す（@codex #334 P1）", async () => {
    // ⚠sequence の生の剰余だと、点が2つしかない短い巡回が thinStep=2 で
    // 1点に減り「2点未満は線にしない」で黙って消える。落とした件数にも
    // 出ないので、歩いた道が「誰も通っていない」ように見える。
    const big = COVERAGE_TRACK_POINT_BUDGET * 3;
    mockQueries([sess("s1", big)], [pt("s1", 35.68, 139.76), pt("s1", 35.6801, 139.7601)]);
    await GET(makeReq());
    const points = rawCall(1);
    expect(points?.sql).toContain("row_number() OVER");
    expect(points?.sql).toContain("x.rn = 1");
    expect(points?.sql).toContain("x.rn = x.cnt");
    expect(points?.sql).toContain("(x.rn - 1) %");
    // 間引き幅が束縛値に載っている
    expect(points?.values).toContain(3);
  });
});

describe("3-b. 記録が途切れた所で線を切る（@codex #334 P2）", () => {
  it("同じ巡回でも時間が大きく空いたら別の線にする", () => {
    // 位置記録を止めて再開した / GPS が一時停止した場合、次の点は同じ巡回の
    // まま遠く離れる。1本につなぐと通っていない道を直線が横切る。
    mockQueries(
      [sess("s1", 4)],
      [
        pt("s1", 35.68, 139.76, 0),
        pt("s1", 35.681, 139.761, 10_000),
        // 30 分後（しきい値 2 分を大きく超える）
        pt("s1", 35.7, 139.78, 1_810_000),
        pt("s1", 35.701, 139.781, 1_820_000),
      ],
    );
    return GET(makeReq())
      .then((res) => res.json() as Promise<TrackBody>)
      .then((body) => {
        expect(body.data.lineCount).toBe(2);
        expect(body.data.lines[0]).toHaveLength(2);
        expect(body.data.lines[1]).toHaveLength(2);
      });
  });

  it("時間が空いていなくても遠く離れたら別の線にする", () => {
    mockQueries(
      [sess("s1", 4)],
      [
        pt("s1", 35.68, 139.76, 0),
        pt("s1", 35.681, 139.761, 10_000),
        // 10 秒で約 2km（徒歩ではありえない）
        pt("s1", 35.7, 139.76, 20_000),
        pt("s1", 35.701, 139.761, 30_000),
      ],
    );
    return GET(makeReq())
      .then((res) => res.json() as Promise<TrackBody>)
      .then((body) => {
        expect(body.data.lineCount).toBe(2);
      });
  });

  it("切った結果1本も線が残らなければ落とした件数に数える（黙って減らさない）", () => {
    // 3点すべてが離れていると、どの断片も1点になり線にならない。
    mockQueries(
      [sess("s1", 3)],
      [
        pt("s1", 35.6, 139.7, 0),
        pt("s1", 35.9, 139.9, 600_000),
        pt("s1", 36.2, 140.1, 1_200_000),
      ],
    );
    return GET(makeReq())
      .then((res) => res.json() as Promise<TrackBody>)
      .then((body) => {
        expect(body.data.lineCount).toBe(0);
        expect(body.data.droppedTrips).toBeGreaterThanOrEqual(1);
        expect(body.data.truncated).toBe(true);
      });
  });

  it("時刻を応答に載せない（切り分けにだけ使う）", () => {
    mockQueries(
      [sess("s1", 2)],
      [pt("s1", 35.68, 139.76, 0), pt("s1", 35.681, 139.761, 10_000)],
    );
    return GET(makeReq())
      .then((res) => res.json() as Promise<TrackBody>)
      .then((body) => {
        expect(JSON.stringify(body)).not.toMatch(/"at"/);
      });
  });
});

describe("4. 量が多すぎる時", () => {
  it("候補の上限を超えたら「◯件以上」として伝える（@codex #334 P2）", async () => {
    // ⚠SQL は上限+1 でしか引かないので、**何本あふれたかは分からない**。
    // 「1件だけ足りない」と出すと、実際は何十件も欠けているのにほぼ完全に
    // 見えてしまう。
    const many = Array.from({ length: COVERAGE_TRACK_SESSION_LIMIT + 1 }, (_, i) =>
      sess(`s${i}`, 1),
    );
    mockQueries(many, [pt("s0", 35.68, 139.76), pt("s0", 35.6801, 139.7601)]);
    const res = await GET(makeReq());
    const body = (await res.json()) as TrackBody;
    expect(body.data.truncated).toBe(true);
    expect(body.data.droppedTrips).toBeGreaterThanOrEqual(1);
    expect(body.data.droppedTripsExact).toBe(false);
  });

  it("上限内なら本数は正確に出す", async () => {
    mockQueries(
      [sess("a", 2), sess("b", 2)],
      [pt("a", 35.68, 139.76), pt("a", 35.6801, 139.7601), pt("b", 35.69, 139.77), pt("b", 35.6901, 139.7701)],
    );
    const res = await GET(makeReq());
    const body = (await res.json()) as TrackBody;
    expect(body.data.droppedTrips).toBe(0);
    expect(body.data.droppedTripsExact).toBe(true);
  });

  it("安全弁に当たったら末尾の巡回は丸ごと落とす（欠けた線を描かない）", async () => {
    const cap = COVERAGE_TRACK_POINT_BUDGET * 2;
    // cap + 1 行返す。末尾 (= cap 番目) の巡回は点が欠けている可能性がある。
    const rows = [
      ...Array.from({ length: cap }, () => pt("full", 35.68, 139.76)),
      pt("partial", 9, 9),
    ];
    mockQueries([sess("full", cap), sess("partial", 10)], rows);
    const res = await GET(makeReq());
    const body = (await res.json()) as TrackBody;
    expect(body.data.truncated).toBe(true);
    // 欠けている側の点は 1 つも返さない
    const json = JSON.stringify(body.data.lines);
    expect(json).not.toContain("9,");
    expect(body.data.lineCount).toBe(1);
  });

  it("対象が無ければ空で返す（2本目のクエリを投げない）", async () => {
    (prisma.$queryRaw as unknown as Mock).mockResolvedValueOnce([]);
    const res = await GET(makeReq());
    const body = (await res.json()) as TrackBody;
    expect(body.data.lineCount).toBe(0);
    expect((prisma.$queryRaw as unknown as Mock).mock.calls).toHaveLength(1);
  });
});

describe("5. 期間と範囲（面の色と同じ条件で見る）", () => {
  it("期間の下限は naive(UTC) に直してから比べる（9時間ずれる罠）", async () => {
    mockQueries([], []);
    await GET(makeReq(`${BBOX}&days=365`));
    expect(rawCall(0)?.sql).toContain("AT TIME ZONE 'UTC'");
  });

  it("全期間 (days=0) では期間の下限を掛けない", async () => {
    mockQueries([], []);
    await GET(makeReq(`${BBOX}&days=0`));
    // fromAt = null が束縛される
    expect(rawCall(0)?.values).toContain(null);
  });

  it("範囲が広すぎる要求は弾く（面と同じ検証を使う）", async () => {
    const res = await GET(
      makeReq("north=36.5&south=35.0&east=141.0&west=139.0&days=365"),
    );
    expect(res.status).toBe(422);
    expect(prisma.$queryRaw as unknown as Mock).not.toHaveBeenCalled();
  });

  it("期間は 1年 か 全期間 だけ（面と同じ）", async () => {
    const res = await GET(makeReq(`${BBOX}&days=30`));
    expect(res.status).toBe(422);
  });
});
