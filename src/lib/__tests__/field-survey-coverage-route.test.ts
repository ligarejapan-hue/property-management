/**
 * 踏破ヒートの集計 API (`GET /api/field-survey/coverage/cells`) の振る舞い固定。
 *
 * 業務背景: 街を歩いて目視で古い家を探すので、短期間に同じ道を二度歩くのは無駄。
 * この画面は「色が付いている＝もう歩いた / 色が無い＝誰も通っていない」と読ませ、
 * 管理者はそれを見て未踏破エリアへ人を出す。したがってこの API の間違いは
 * **そのまま無駄足の指示**になる。ここで固定するのはどれも「間違えると
 * 現場を無駄に歩かせる or 人の居場所が漏れる」性質のものだけ。
 *
 * vitest は env=node なので DOM は使わない。prisma / api-helpers / permissions を
 * vi.mock する流儀は property-duplicate-candidates-scope.test.ts に合わせる。
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
      // ZodError = 入力の不正。本物の handleApiError と同じく 422 に落とす。
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

// ⚠hasPermission は本物と同じ判定をする spy にする。
// 「read だけで通ること」を確かめるには、渡した権限一覧が実際に効いていないと
// 意味が無い (常に true を返すモックだと 2 の表明が空振りする)。
vi.mock("@/lib/permissions", () => ({
  hasPermission: vi.fn(
    (
      permissions: Array<{
        resource: string;
        action: string;
        granted: boolean;
      }>,
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
import {
  getApiSession,
  getUserPermissions,
  ApiError,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import {
  COVERAGE_CELL_LIMIT,
  COVERAGE_CELL_STEPS,
} from "@/lib/field-survey-coverage";
import { GET } from "@/app/api/field-survey/coverage/cells/route";

const adminUser = { id: "u-admin", email: "a@x", name: "管理者", role: "admin" };
const fieldUser = { id: "u-field", email: "f@x", name: "現地", role: "field_staff" };

/** 踏破ヒートを見るのに必要な最小権限 (read だけ)。 */
const readOnly = [{ resource: "field_survey", action: "read", granted: true }];
/** 巡回機能に触れない人 (別リソースの権限しか持たない)。 */
const otherResourceOnly = [
  { resource: "property", action: "read", granted: true },
];

/** 街歩き相当の狭い bbox (0.02度 ≒ 2.2km 四方)。 */
// 街歩き相当 (0.018度 ≒ 2.0km 四方)。⚠fine の上限は約2.15km四方まで狭めてある
// (50m格子で3km四方だと最大3,600マス > 描画上限2,000 になり色が全部消えるため)。
const FINE_BBOX = "north=35.698&south=35.68&east=139.78&west=139.76";
/** 市内相当 (0.05度 ≒ 5.5km 四方)。mid の上限は約10.7km四方。 */
const MID_BBOX = "north=35.70&south=35.65&east=139.80&west=139.75";
/** 市外まで引いた状態 (0.4度)。bbox 上限 0.5度 の内側。 */
const WIDE_BBOX = "north=36.00&south=35.60&east=140.10&west=139.70";

function makeReq(qs: string) {
  return new Request(
    `http://x/api/field-survey/coverage/cells?${qs}`,
  ) as unknown as import("next/server").NextRequest;
}

/** 集計 SQL の呼び出し (タグ付きテンプレートの断片 + 束縛パラメータ)。 */
function rawCall() {
  const call = (prisma.$queryRaw as unknown as Mock).mock.calls[0];
  if (!call) return undefined;
  const [strings, ...values] = call as [string[], ...unknown[]];
  const sqlRaw = strings.join("?");
  return {
    /** 改行/インデントを潰した SQL。整形の揺れで表明が壊れないように。 */
    sql: sqlRaw.replace(/\s+/g, " "),
    sqlRaw,
    values,
  };
}

/** 応答 body (apiResponse は `{ data: ... }` をそのまま JSON にする)。 */
interface CoverageBody {
  data: {
    cell: "fine" | "mid" | "wide";
    cellLabel: string;
    latStep: number;
    lngStep: number;
    days: number;
    cellCount: number;
    maxPasses: number;
    truncated: boolean;
    cells: Array<{ y: number; x: number; p: number }>;
  };
}

async function getBody(res: Response) {
  return (await res.json()) as CoverageBody;
}

/** 集計 SQL が返す行 (::int 済み = ただの整数)。 */
function rows(n: number, p = 1) {
  return Array.from({ length: n }, (_, i) => ({ y: 79000 + i, x: 254000, p }));
}

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue(adminUser);
  (getUserPermissions as Mock).mockResolvedValue(readOnly);
  (prisma.$queryRaw as unknown as Mock).mockResolvedValue([]);
});

describe("誰が見られるか", () => {
  it("巡回を見る権限が無い人には出さない（他社員の行動範囲が推測できてしまうため）", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(otherResourceOnly);
    const res = await GET(makeReq(FINE_BBOX));
    expect(res.status).toBe(403);
    // 権限が無い時点で DB を触らない (403 でも集計だけ走るのは無駄かつ危険)
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("未ログインは 401 のまま素通しにしない", async () => {
    (getApiSession as Mock).mockRejectedValueOnce(
      new ApiError(401, "認証が必要です", "UNAUTHORIZED"),
    );
    const res = await GET(makeReq(FINE_BBOX));
    expect(res.status).toBe(401);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("巡回を見る権限だけで踏破の色は見られる（他人の生軌跡を見る権限まで要求しない）", async () => {
    // 返すのは格子番号と回数だけで「誰が通ったか」が分からない。
    // ここで read_all (＝他人の生軌跡＝勤怠の証拠) まで要求すると、
    // アルバイトが「そこはもう歩いた」を確認できず二度歩きが減らない。
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(readOnly);
    const res = await GET(makeReq(FINE_BBOX));
    expect(res.status).toBe(200);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("read_all を一度も問い合わせない（要求が紛れ込む退行を止める）", async () => {
    await GET(makeReq(FINE_BBOX));
    const asked = (hasPermission as unknown as Mock).mock.calls.map(
      (c) => `${String(c[1])}:${String(c[2])}`,
    );
    expect(asked).toContain("field_survey:read");
    expect(asked).not.toContain("field_survey:read_all");
  });

  it("担当者ごとの絞り込みは受け付けない（色は最初から全社合計）", async () => {
    // 「Aさんが1度通れば1回、Bさんが1度通れば2回」= 全体で見る、がユーザー決定。
    // staff / scope を効かせると個人の行動が読めてしまい、PII の面が広がる。
    await GET(makeReq(`${FINE_BBOX}&staffUserId=${fieldUser.id}&scope=mine`));
    const q = rawCall()!;
    expect(q.values).not.toContain(fieldUser.id);
    expect(q.sql).not.toMatch(/staff_user_id\s*=/);
  });
});

describe("見ている範囲の指定が壊れていたら集計しない", () => {
  it.each([
    ["north が欠けている", "south=35.68&east=139.78&west=139.76"],
    ["south が欠けている", "north=35.70&east=139.78&west=139.76"],
    ["east が欠けている", "north=35.70&south=35.68&west=139.76"],
    ["west が欠けている", "north=35.70&south=35.68&east=139.78"],
  ])("%s なら 422（範囲が決まらないまま全国を集計しない）", async (_name, qs) => {
    const res = await GET(makeReq(qs));
    expect(res.status).toBe(422);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("上下が逆さま (north < south) なら 422", async () => {
    const res = await GET(
      makeReq("north=35.60&south=35.70&east=139.78&west=139.76"),
    );
    expect(res.status).toBe(422);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("左右が逆さま (east < west) なら 422", async () => {
    const res = await GET(
      makeReq("north=35.70&south=35.68&east=139.76&west=139.78"),
    );
    expect(res.status).toBe(422);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("南北に 0.5 度を超えて広い範囲は 422（全社の軌跡を丸ごと走査させない）", async () => {
    const res = await GET(
      makeReq("north=36.30&south=35.68&east=139.78&west=139.76"),
    );
    expect(res.status).toBe(422);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("東西に 0.5 度を超えて広い範囲は 422", async () => {
    const res = await GET(
      makeReq("north=35.70&south=35.68&east=140.40&west=139.76"),
    );
    expect(res.status).toBe(422);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("エラー文言に見ていた座標を書き戻さない（画面の位置＝人の居場所のヒントになる）", async () => {
    const res = await GET(
      makeReq("north=35.60&south=35.70&east=139.78&west=139.76"),
    );
    expect(res.status).toBe(422);
    const text = await res.text();
    for (const v of ["35.60", "35.70", "139.78", "139.76"]) {
      expect(text).not.toContain(v);
    }
  });
});

describe("期間は「直近1年」か「全期間」だけ", () => {
  it("何も指定しなければ直近1年（既定で全期間を舐めない）", async () => {
    const res = await GET(makeReq(FINE_BBOX));
    expect((await getBody(res)).data.days).toBe(365);
    // 下限時刻が束縛される = 期間で切れている（オフセット付き ISO 文字列。
    // Date のまま束縛しない理由は「期間の下限も naive(UTC) 同士で比べる」参照）
    expect(
      rawCall()!.values.some(
        (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v),
      ),
    ).toBe(true);
  });

  it("365 を明示しても同じ", async () => {
    const res = await GET(makeReq(`${FINE_BBOX}&days=365`));
    expect((await getBody(res)).data.days).toBe(365);
  });

  it("0（全期間）は下限時刻を置かない", async () => {
    const res = await GET(makeReq(`${FINE_BBOX}&days=0`));
    expect((await getBody(res)).data.days).toBe(0);
    const q = rawCall()!;
    // 全期間 = fromAt が null。SQL 側の `IS NULL OR ...` で期間条件が無効化される。
    expect(q.values.some((v) => v instanceof Date)).toBe(false);
    expect(q.values.filter((v) => v === null).length).toBe(2);
  });

  it.each(["30", "180", "1000", "-1", "abc", "365.5"])(
    "%s のような中途半端な期間は 422（画面の凡例と食い違う色を出さない）",
    async (days) => {
      const res = await GET(makeReq(`${FINE_BBOX}&days=${days}`));
      expect(res.status).toBe(422);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    },
  );
});

describe("応答に人の足取りが混ざらない", () => {
  it("生座標・人名・日時・セッションIDを1つも返さない", async () => {
    (prisma.$queryRaw as unknown as Mock).mockResolvedValue([
      { y: 79291, x: 254121, p: 3 },
    ]);
    const res = await GET(makeReq(FINE_BBOX));
    const body = await getBody(res);
    const raw = JSON.stringify(body);

    // ⚠"lat"/"lng" は **キーとして** 現れないことを見る。latStep/lngStep は
    // 「1マスの幅」であって座標ではなく、クライアントが矩形を復元するのに要る
    // (サーバと幅がずれると全セルが1マス分ずれて色が道路をまたぐ)。
    expect(raw).not.toMatch(/"lat"\s*:/);
    expect(raw).not.toMatch(/"lng"\s*:/);
    expect(raw).not.toMatch(/"latitude"\s*:/);
    expect(raw).not.toMatch(/"longitude"\s*:/);
    // 人・時刻・セッションは語そのものが出てはいけない
    expect(raw).not.toMatch(/staff/i);
    expect(raw).not.toMatch(/recordedAt/i);
    expect(raw).not.toMatch(/sessionId/i);
    expect(raw).not.toMatch(/userId/i);
    // 日時 (ISO8601) が紛れ込んでいない = 「いつ通ったか」を返していない
    expect(raw).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    // 見ていた bbox もそのまま書き戻さない
    expect(raw).not.toContain("35.68");
    expect(raw).not.toContain("139.76");
  });

  it("1セルが持つのは格子番号と回数の3項目だけ", async () => {
    (prisma.$queryRaw as unknown as Mock).mockResolvedValue([
      // ⚠SQL は必要な3列しか SELECT しないが、将来 SELECT を増やしたときに
      // そのまま素通しで返さないことを確かめる (行を丸ごと spread しない)。
      {
        y: 1,
        x: 2,
        p: 3,
        staffUserId: "u-field",
        lat: 35.6812,
        lng: 139.7671,
        recordedAt: new Date("2026-07-01T00:00:00Z"),
      },
    ]);
    const res = await GET(makeReq(FINE_BBOX));
    const cell = (await getBody(res)).data.cells[0];
    expect(Object.keys(cell).sort()).toEqual(["p", "x", "y"]);
  });

  it("巡回中の人が誰かを問い合わせもしない（SQL の中でだけ使い、外に出さない）", async () => {
    await GET(makeReq(FINE_BBOX));
    const q = rawCall()!;
    // 集計の内側では staff_user_id を使う (人ごとに1回と数えるため)
    expect(q.sql).toContain("staff_user_id");
    // ただし SELECT リストには出さない = 応答へ漏れない
    expect(q.sql).not.toMatch(/AS "staffUserId"/);
    expect(q.sql).not.toMatch(/AS "recordedAt"/);
  });
});

describe("回数は整数で返る（JSON にできない値を作らない）", () => {
  it("集計値は整数のまま返る（描画側で NaN にならない）", async () => {
    (prisma.$queryRaw as unknown as Mock).mockResolvedValue([
      { y: 79291, x: 254121, p: 7 },
    ]);
    const res = await GET(makeReq(FINE_BBOX));
    const body = await getBody(res);
    for (const c of body.data.cells) {
      for (const v of [c.y, c.x, c.p]) {
        expect(typeof v).toBe("number");
        expect(Number.isInteger(v)).toBe(true);
      }
    }
    expect(body.data.maxPasses).toBe(7);
  });

  it("count と floor の両方を ::int にしている（外すと地図が真っ白になる）", async () => {
    await GET(makeReq(FINE_BBOX));
    const { sql } = rawCall()!;
    // count(...) は bigint。::int を外すと JSON 化で BigInt が例外 → 500。
    expect(sql).toMatch(/\)\)::int/);
    // floor(...) は numeric。::int を外すと文字列で返り、
    // クライアントの矩形計算が全滅して色が出ない。
    expect(sql).toMatch(/floor\(tp\.lat[^)]*\)::int/);
    expect(sql).toMatch(/floor\(tp\.lng[^)]*\)::int/);
  });

  it("キャストを外すと 200 を返せなくなる（退行の再現）", async () => {
    // ドライバが bigint をそのまま返す状態＝::int を外した状態の再現。
    // JSON にできないので応答が作れず、地図には何も出ない。
    expect(() => JSON.stringify({ p: BigInt(3) })).toThrow();
    (prisma.$queryRaw as unknown as Mock).mockResolvedValue([
      { y: BigInt(79291), x: BigInt(254121), p: BigInt(3) },
    ]);
    const res = await GET(makeReq(FINE_BBOX));
    expect(res.status).not.toBe(200);
  });
});

describe("取りこぼしたら色を一切出さない（未踏破と誤って指示しないため）", () => {
  it("上限を超えたら truncated=true かつセルは空", async () => {
    // ⚠一部だけ返すと「歩いた場所が色無し」になり、管理者がそこへ人を出す。
    // 二度歩きを減らすための機能が二度歩きを作る、という一番まずい壊れ方。
    (prisma.$queryRaw as unknown as Mock).mockResolvedValue(
      rows(COVERAGE_CELL_LIMIT + 1),
    );
    const res = await GET(makeReq(FINE_BBOX));
    const body = await getBody(res);
    expect(body.data.truncated).toBe(true);
    expect(body.data.cells).toEqual([]);
    expect(body.data.cellCount).toBe(0);
    expect(body.data.maxPasses).toBe(0);
  });

  it("ちょうど上限までは全部返す（無用に色を消さない）", async () => {
    (prisma.$queryRaw as unknown as Mock).mockResolvedValue(
      rows(COVERAGE_CELL_LIMIT),
    );
    const res = await GET(makeReq(FINE_BBOX));
    const body = await getBody(res);
    expect(body.data.truncated).toBe(false);
    expect(body.data.cells.length).toBe(COVERAGE_CELL_LIMIT);
    expect(body.data.cellCount).toBe(COVERAGE_CELL_LIMIT);
  });

  it("上限を超えたか判るように上限+1 件まで読む", async () => {
    await GET(makeReq(FINE_BBOX));
    // ちょうど上限件で LIMIT すると「超えている」ことに気づけず、
    // 黙って一部だけ返す＝取りこぼしに戻る。
    expect(rawCall()!.values).toContain(COVERAGE_CELL_LIMIT + 1);
  });

  it("1件も歩いていない範囲は空で返る（エラーにしない）", async () => {
    const res = await GET(makeReq(FINE_BBOX));
    const body = await getBody(res);
    expect(res.status).toBe(200);
    expect(body.data.truncated).toBe(false);
    expect(body.data.cells).toEqual([]);
    expect(body.data.maxPasses).toBe(0);
  });
});

describe("マスの大きさは地図の寄り引きで自動で決まる（利用者に選ばせない）", () => {
  it("街歩きの寄りでは細かいマス", async () => {
    const res = await GET(makeReq(FINE_BBOX));
    const body = await getBody(res);
    expect(body.data.cell).toBe("fine");
    expect(body.data.latStep).toBe(COVERAGE_CELL_STEPS.fine.latStep);
    expect(body.data.lngStep).toBe(COVERAGE_CELL_STEPS.fine.lngStep);
    expect(body.data.cellLabel).toBe("約50m");
  });

  it("市内まで引くと中くらいのマス", async () => {
    const res = await GET(makeReq(MID_BBOX));
    const body = await getBody(res);
    expect(body.data.cell).toBe("mid");
    expect(body.data.latStep).toBe(COVERAGE_CELL_STEPS.mid.latStep);
  });

  it("市外まで引くと粗いマス（セル数が上限で潰れないように）", async () => {
    const res = await GET(makeReq(WIDE_BBOX));
    const body = await getBody(res);
    expect(body.data.cell).toBe("wide");
    expect(body.data.latStep).toBe(COVERAGE_CELL_STEPS.wide.latStep);
  });

  it("選んだマスの幅がそのまま集計の丸め幅として渡る（画面とサーバでずれない）", async () => {
    await GET(makeReq(MID_BBOX));
    const q = rawCall()!;
    expect(q.values).toContain(COVERAGE_CELL_STEPS.mid.latStep);
    expect(q.values).toContain(COVERAGE_CELL_STEPS.mid.lngStep);
  });
});

describe("数え方（同じ人の同じ日は1回・日付は日本時間）", () => {
  it("同じ人が同じ日に何度通っても1回として数える", async () => {
    // 立ち止まっただけ / 往復しただけで色が跳ねると「もう十分」の判断が狂う。
    await GET(makeReq(FINE_BBOX));
    const { sql } = rawCall()!;
    expect(sql).toContain("count(DISTINCT");
    expect(sql).toContain("staff_user_id");
    // (担当者, 日付) の組で数えている
    expect(sql).toMatch(
      /count\(DISTINCT \( s\.staff_user_id, .*::date \)\)::int/,
    );
  });

  it("日付は日本時間の暦日で切る（UTC だと朝の巡回が前日扱いになる）", async () => {
    await GET(makeReq(FINE_BBOX));
    const { sql } = rawCall()!;
    expect(sql).toContain("AT TIME ZONE 'Asia/Tokyo'");
    expect(sql).toContain("::date");
  });

  it("終了した巡回だけを数える（取り消しも進行中も数えない）", async () => {
    // 取り消し: 開始してすぐ取り消した巡回は歩いていない。色が付くと未踏破エリアを
    // 踏破済みに見せてしまう＝一番拾いたい場所を落とす。
    //
    // ⚠進行中も数えない (@codex #332 P1)。稼働が2〜3人の職場で進行中の巡回まで
    // 含めると、**地図を更新し続けるだけで同僚の現在の移動が追える**
    // （50m マスが増えていく様子がその人の経路そのものになる）。
    // 集計で人名を伏せても、少人数かつリアルタイムだと実質的に個人の追跡になる。
    // この endpoint が read_all を要求しないでいられるのは、この制限とセット。
    await GET(makeReq(FINE_BBOX));
    const sql = rawCall()!.sql;
    expect(sql).toContain("= 'ended'");
    // 「cancelled だけ除外」に戻すと進行中が混ざる
    expect(sql).not.toContain("<> 'cancelled'");
  });
});

describe("SQL に生の値を埋め込まない", () => {
  it("bbox も期間も丸め幅もすべてパラメータで渡す", async () => {
    await GET(makeReq(`${FINE_BBOX}&days=365`));
    const q = rawCall()!;
    // 生値が SQL 文字列に出ていない (SQL インジェクションの面を作らない)
    for (const v of ["35.7", "35.68", "139.78", "139.76"]) {
      expect(q.sqlRaw).not.toContain(v);
    }
    // 束縛側には出ている
    // ⚠画面端の生値ではなく**格子に揃えた値**が束縛される (@codex #332)。
    // 端がセルを横切ると色が動くのを防ぐため、集計はセル単位で行う。
    const bound = q.values.filter((v): v is number => typeof v === "number");
    for (const v of bound.filter((x) => x > 35 && x < 36)) {
      const k = v / COVERAGE_CELL_STEPS.fine.latStep;
      expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-6);
    }
    // 生値をそのまま埋めていない
    expect(bound).not.toContain(35.698);
    // 経度側も同様に格子へ揃う
    for (const v of bound.filter((x) => x > 139 && x < 140)) {
      const k = v / COVERAGE_CELL_STEPS.fine.lngStep;
      expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-6);
    }
    // 型を固定するキャストが付いている (numeric 比較が文字列比較にならない)
    expect(q.sql).toContain("::numeric");
    expect(q.sql).toContain("::timestamptz");
  });

  it("bbox の 4 辺すべてで軌跡を絞る（画面外まで数えない）", async () => {
    await GET(makeReq(FINE_BBOX));
    const { sql } = rawCall()!;
    expect(sql).toMatch(/tp\.lat >= /);
    // ⚠上端・右端は `<`（半開区間）。セル番号は floor で決まるので、
    // 境界ちょうどの点は上のセルに属する。`<=` だと隣のセルへ二重計上される。
    expect(sql).toMatch(/tp\.lat < /);
    expect(sql).toMatch(/tp\.lng >= /);
    expect(sql).toMatch(/tp\.lng < /);
  });

  it("集計は一度の問い合わせで済ませる（地図の pan/zoom ごとに呼ばれるため）", async () => {
    await GET(makeReq(FINE_BBOX));
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe("日付は JST の暦日で切る（保存値は UTC の壁時計）", () => {
  // ⚠recorded_at は timestamp without time zone に **UTC の壁時計値**が入る。
  // そこへいきなり AT TIME ZONE 'Asia/Tokyo' を当てると「その値は既に東京時刻」
  // と解釈され 9 時間ずれる (@codex #332 P2)。
  // 本番実測: 保存値 2026-07-20 23:00 (= JST 7/21 08:00) が
  //   いきなり Asia/Tokyo → 7/20 ✗ / 一度 UTC と解釈してから → 7/21 ✓
  // = **JST の 0〜9 時に記録した点が前日に数えられていた**。朝から歩く業務なので
  // 「同じ人が同じ日に何度通っても1回」が壊れ、回数と色が狂う。

  it("UTC として解釈してから JST へ変換する（順序が逆だと 9 時間ずれる）", async () => {
    await GET(makeReq(FINE_BBOX));
    const sql = rawCall()!.sql;
    expect(sql).toContain("AT TIME ZONE 'UTC'");
    expect(sql).toContain("AT TIME ZONE 'Asia/Tokyo'");
    // UTC への解釈が先であること（この順序が壊れると前日に寄る）
    expect(sql.indexOf("AT TIME ZONE 'UTC'")).toBeLessThan(
      sql.indexOf("AT TIME ZONE 'Asia/Tokyo'"),
    );
    // 「いきなり Asia/Tokyo」に戻っていないこと
    expect(sql).not.toMatch(/recorded_at AT TIME ZONE 'Asia\/Tokyo'/);
  });

  it("期間の下限も naive(UTC) 同士で比べる（セッションTZに依存させない）", async () => {
    await GET(makeReq(FINE_BBOX + "&days=365"));
    const { sql, values } = rawCall()!;
    // timestamptz と naive を直接比べると、naive 側がセッションTZで解釈されてずれる
    expect(sql).toMatch(/recorded_at >= \(\?::timestamptz AT TIME ZONE 'UTC'\)/);
    // ⚠束縛は Date ではなく**オフセット付き ISO 文字列**で行う。Prisma は Date を
    // オフセット無しの UTC 壁時計テキスト（例 '2026-07-01 03:16:40'）で送るため、
    // ::timestamptz がセッション TZ で解釈して 9 時間ずれる（dev の Asia/Tokyo で
    // 実測）。'...Z' 付きならどの TZ の DB でも同じ瞬間になる。
    expect(values.every((v) => !(v instanceof Date))).toBe(true);
    expect(
      values.some(
        (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v),
      ),
    ).toBe(true);
  });

  it("境界の意味を固定する（SQL の意図を JS で再現して突き合わせる）", () => {
    // 実 DB は使えないので、SQL の意味を JS で再現する。
    // 保存値は UTC の壁時計なので、JST の暦日 = UTC + 9時間 の日付。
    const jstDayOf = (storedUtcWallClock: string): string => {
      const asUtc = new Date(storedUtcWallClock + "Z");
      const jst = new Date(asUtc.getTime() + 9 * 60 * 60 * 1000);
      return jst.toISOString().slice(0, 10);
    };
    // 朝 8 時の巡回 (= UTC 前日 23:00)
    expect(jstDayOf("2026-07-20T23:00:00")).toBe("2026-07-21");
    // 深夜 0:30 (= UTC 前日 15:30)
    expect(jstDayOf("2026-07-20T15:30:00")).toBe("2026-07-21");
    // 日中はそのまま
    expect(jstDayOf("2026-07-21T03:00:00")).toBe("2026-07-21");
    // JST 23:59 (= UTC 14:59) はまだ同じ日
    expect(jstDayOf("2026-07-21T14:59:00")).toBe("2026-07-21");
    // JST 翌 0:00 (= UTC 15:00) で日が変わる
    expect(jstDayOf("2026-07-21T15:00:00")).toBe("2026-07-22");
  });
});

describe("集計は格子境界に揃えた範囲で行う (@codex #332)", () => {
  it("画面の端がセルを横切っていても、集計はセル単位で行う", async () => {
    // 端が半端な位置の bbox を渡す
    await GET(makeReq("north=35.6857&south=35.68123&east=139.7657&west=139.76123"));
    const { values } = rawCall()!;
    // 束縛値のうち緯度・経度は格子の倍数になっているはず
    const nums = values.filter((v): v is number => typeof v === "number");
    const lat = nums.filter((v) => v > 35 && v < 36);
    const lng = nums.filter((v) => v > 139 && v < 140);
    expect(lat.length).toBeGreaterThan(0);
    expect(lng.length).toBeGreaterThan(0);
    for (const v of lat) {
      const k = v / COVERAGE_CELL_STEPS.fine.latStep;
      expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-6);
    }
    for (const v of lng) {
      const k = v / COVERAGE_CELL_STEPS.fine.lngStep;
      expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-6);
    }
    // 生の画面端の値をそのまま渡していないこと
    expect(nums).not.toContain(35.68123);
    expect(nums).not.toContain(139.76123);
  });
});
