import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response {
    static json = (b: unknown, init?: ResponseInit) => Response.json(b, init);
  }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(s: number, m: string, c = "ERROR") {
      super(m);
      this.status = s;
      this.code = c;
    }
  }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(),
    getUserPermissions: vi.fn(),
    parseJsonBody: vi.fn(async (r: Request) => {
      const t = await r.text();
      return t ? JSON.parse(t) : {};
    }),
    handleApiError: vi.fn((e: unknown) =>
      e instanceof MockApiError
        ? Response.json({ error: { message: e.message, code: e.code } }, { status: e.status })
        : Response.json({ error: { code: "INTERNAL_ERROR", message: String((e as Error)?.message ?? e) } }, { status: 500 }),
    ),
  };
});
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    dmScenario: {
      findFirst: vi.fn(async () => null),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(async () => ({})),
    },
    dmScenarioMedia: {
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async () => ({ count: 0 })),
    },
    $queryRaw: vi.fn(async () => [{ id: "s1", deleted_at: null }]),
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { default: db };
});

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { GET } from "../../app/api/properties/sale-dm/scenarios/[id]/lp-prompt/route";
import { PUT } from "../../app/api/properties/sale-dm/scenarios/[id]/lp-template/route";
import { buildLpExternalPrompt, promptDigest, bodyTemplateDigest } from "../sale-dm-letter/external-prompt";
import { rowsToPlan, planToRows, type MediaRow } from "../sale-dm-letter/lp-media-rows";
import type { MediaPlan } from "../sale-dm-letter/lp-media";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  dmScenario: { findFirst: Fn; findUniqueOrThrow: Fn; update: Fn };
  dmScenarioMedia: { findMany: Fn; deleteMany: Fn; createMany: Fn };
  $queryRaw: Fn;
};

const SID = "44444444-4444-4444-8444-444444444444";
const ctx = { params: Promise.resolve({ id: SID }) };

const LP_SETTINGS = { tone: "formal", length: "medium", appeal: "price", strength: "medium" };
const LP_DIGEST = promptDigest(buildLpExternalPrompt(LP_SETTINGS));

const OLD_BODY = "■見出し1\n本文1\n■見出し2\n本文2";
const NEW_BODY_SAME_HEADINGS = "■見出し1\n本文1改\n■見出し2\n本文2改";
const NEW_BODY_DROPPED = "■見出し1\n本文1改";

function template(body: string): string {
  return `【見出し】\n見出しA\n【本文】\n${body}`;
}

const scenarioRow = (over: Record<string, unknown> = {}) => ({
  id: SID,
  name: "既存の種類",
  autoKey: null,
  sortOrder: 10,
  active: true,
  lpTone: LP_SETTINGS.tone,
  lpLength: LP_SETTINGS.length,
  lpAppeal: LP_SETTINGS.appeal,
  lpStrength: LP_SETTINGS.strength,
  lpPromptText: "指示文",
  lpRawTemplate: template(OLD_BODY),
  lpHeadline: "見出しA",
  lpLead: null,
  lpBodyText: OLD_BODY,
  lpFaqJson: null,
  deletedAt: null,
  ...over,
});

const req = (method: string, body?: unknown) =>
  new Request("http://x", { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

/** PUT の baseBodyDigest は既定で「今の保存済み原本」に合わせて自動で入れる。ずれを試す
 *  テストだけ明示で上書きする。 */
const put = (b: Record<string, unknown>, baseBody: string | null = template(OLD_BODY)) =>
  req("PUT", { baseBodyDigest: bodyTemplateDigest(baseBody), ...b });

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Fn).mockResolvedValue([
    { resource: "user_management", action: "write", granted: true },
  ]);
  pm.dmScenario.findFirst.mockResolvedValue(scenarioRow());
  pm.dmScenario.findUniqueOrThrow.mockResolvedValue(scenarioRow());
  pm.dmScenario.update.mockResolvedValue({});
  pm.dmScenarioMedia.findMany.mockResolvedValue([]);
  pm.dmScenarioMedia.deleteMany.mockResolvedValue({ count: 0 });
  pm.dmScenarioMedia.createMany.mockResolvedValue({ count: 0 });
  pm.$queryRaw.mockResolvedValue([{ id: SID, deleted_at: null }]);
});

describe("GET /scenarios/[id]/lp-prompt(台帳のLPの指示文)", () => {
  it("LPの書き方の設定のどれかが未設定 → 400 SCENARIO_SETTINGS_INCOMPLETE", async () => {
    pm.dmScenario.findFirst.mockResolvedValue(scenarioRow({ lpTone: null }));
    const res = await GET(req("GET"), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("SCENARIO_SETTINGS_INCOMPLETE");
  });

  it("buildLpExternalPrompt の結果と、その指紋・原本の指紋・原本を返す", async () => {
    pm.dmScenario.findFirst.mockResolvedValue(scenarioRow({ lpRawTemplate: null }));
    const res = await GET(req("GET"), ctx);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.prompt).toBe(buildLpExternalPrompt(LP_SETTINGS));
    expect(j.digest).toBe(LP_DIGEST);
    expect(j.bodyDigest).toBe(bodyTemplateDigest(null));
    expect(j.body).toBeNull();
  });

  it("削除済み/存在しない → 404 SCENARIO_NOT_FOUND", async () => {
    pm.dmScenario.findFirst.mockResolvedValue(null);
    const res = await GET(req("GET"), ctx);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("SCENARIO_NOT_FOUND");
  });

  it("管理者以外は 403", async () => {
    (getUserPermissions as Fn).mockResolvedValue([{ resource: "property", action: "write", granted: true }]);
    const res = await GET(req("GET"), ctx);
    expect(res.status).toBe(403);
  });
});

describe("PUT /scenarios/[id]/lp-template(台帳のLPの貼り戻し)", () => {
  it("同じ原文 → changed:false・保存しない", async () => {
    const res = await PUT(put({ body: template(OLD_BODY), promptDigest: LP_DIGEST }), ctx);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.changed).toBe(false);
    expect(j.bodyDigest).toBe(bodyTemplateDigest(template(OLD_BODY)));
    expect(pm.dmScenario.update).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("LPの書き方の設定が変わっていたら 409 PROMPT_STALE", async () => {
    const res = await PUT(put({ body: template(NEW_BODY_SAME_HEADINGS), promptDigest: "0".repeat(64) }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("PROMPT_STALE");
    expect(pm.dmScenario.update).not.toHaveBeenCalled();
  });

  it("見えていた原本(baseBodyDigest)が今と違う → 409 TEMPLATE_STALE", async () => {
    const res = await PUT(
      put({ body: template(NEW_BODY_SAME_HEADINGS), promptDigest: LP_DIGEST }, "開いたときは別の原本だった"),
      ctx,
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("TEMPLATE_STALE");
    expect(pm.dmScenario.update).not.toHaveBeenCalled();
  });

  it("切り分けに失敗 → 400 INVALID_LP_TEMPLATE(メッセージは lpSplitIssueMessage)", async () => {
    const res = await PUT(put({ body: "見出しも本文もない文章", promptDigest: LP_DIGEST }), ctx);
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error.code).toBe("INVALID_LP_TEMPLATE");
    expect(j.error.message).toContain("見出し");
    expect(pm.dmScenario.update).not.toHaveBeenCalled();
  });

  it("正常: 4部位+プロンプトを保存し、見出しが変わらない節の写真は引き継ぎ、消えた見出しの節は落とす(hero は触らない)", async () => {
    const section1: MediaRow = { slot: "section", heading: "見出し1", assetId: "asset-1", figureKind: null, sortOrder: 1 };
    const section2: MediaRow = { slot: "section", heading: "見出し2", assetId: null, figureKind: "sale_flow", sortOrder: 2 };
    pm.dmScenarioMedia.findMany.mockResolvedValue([section1, section2]);

    const res = await PUT(put({ body: template(NEW_BODY_DROPPED), promptDigest: LP_DIGEST }), ctx);
    expect(res.status).toBe(200);

    expect(pm.dmScenario.update).toHaveBeenCalledWith({
      where: { id: SID },
      data: {
        lpRawTemplate: template(NEW_BODY_DROPPED),
        lpPromptText: buildLpExternalPrompt(LP_SETTINGS),
        lpHeadline: "見出しA",
        lpLead: null,
        lpBodyText: NEW_BODY_DROPPED,
        lpFaqJson: expect.anything(),
      },
    });

    // 見出し2は本文から消えたので section 行から落ち、見出し1は引き継がれる。hero は問い合わせも削除もしない。
    expect(pm.dmScenarioMedia.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { scenarioId: SID, slot: "section" } }),
    );
    expect(pm.dmScenarioMedia.deleteMany).toHaveBeenCalledWith({ where: { scenarioId: SID, slot: "section" } });
    expect(pm.dmScenarioMedia.createMany).toHaveBeenCalledWith({
      data: [{ slot: "section", heading: "見出し1", assetId: "asset-1", figureKind: null, sortOrder: 1, scenarioId: SID }],
    });

    expect(writeAuditLog).toHaveBeenCalledWith({
      userId: "u1",
      action: "sale_dm_scenario_lp_template",
      targetTable: "dm_scenarios",
      targetId: SID,
      detail: { length: template(NEW_BODY_DROPPED).length, sectionCount: 1 },
    });

    const j = await res.json();
    expect(j.changed).toBe(true);
    expect(j.bodyDigest).toBe(bodyTemplateDigest(template(NEW_BODY_DROPPED)));
  });

  it("見出しが1つも残らなければ createMany は呼ばない", async () => {
    pm.dmScenarioMedia.findMany.mockResolvedValue([
      { slot: "section", heading: "見出し1", assetId: "asset-1", figureKind: null, sortOrder: 1 },
    ]);
    const body = "【見出し】\n見出しB\n【本文】\n小見出しの無い本文";
    const res = await PUT(put({ body, promptDigest: LP_DIGEST }), ctx);
    expect(res.status).toBe(200);
    expect(pm.dmScenarioMedia.deleteMany).toHaveBeenCalledWith({ where: { scenarioId: SID, slot: "section" } });
    expect(pm.dmScenarioMedia.createMany).not.toHaveBeenCalled();
  });

  it("削除済み → 404 SCENARIO_NOT_FOUND・保存しない", async () => {
    pm.$queryRaw.mockResolvedValue([{ id: SID, deleted_at: new Date() }]);
    const res = await PUT(put({ body: template(NEW_BODY_SAME_HEADINGS), promptDigest: LP_DIGEST }), ctx);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("SCENARIO_NOT_FOUND");
    expect(pm.dmScenario.update).not.toHaveBeenCalled();
  });

  it("管理者以外は 403・処理に入らない", async () => {
    (getUserPermissions as Fn).mockResolvedValue([{ resource: "property", action: "write", granted: true }]);
    const res = await PUT(put({ body: template(NEW_BODY_SAME_HEADINGS), promptDigest: LP_DIGEST }), ctx);
    expect(res.status).toBe(403);
    expect(pm.dmScenario.update).not.toHaveBeenCalled();
  });
});

describe("rowsToPlan/planToRows(移設の回帰: 往復が恒等)", () => {
  it("hero行+section行 → 枠 → 行 が元と同じ(順序込み)", () => {
    const rows: MediaRow[] = [
      { slot: "hero", heading: null, assetId: "asset-hero", figureKind: null, sortOrder: 0 },
      { slot: "section", heading: "見出し1", assetId: "asset-1", figureKind: null, sortOrder: 1 },
      { slot: "section", heading: "見出し2", assetId: null, figureKind: "sale_flow", sortOrder: 2 },
    ];
    const plan: MediaPlan = rowsToPlan(rows);
    expect(plan).toEqual({
      hero: { assetId: "asset-hero" },
      sections: [
        { heading: "見出し1", media: { kind: "asset", assetId: "asset-1" } },
        { heading: "見出し2", media: { kind: "figure", figureKind: "sale_flow" } },
      ],
    });
    expect(planToRows(plan)).toEqual(rows);
  });

  it("media:null の節は行を作らない(枠→行→枠でも消えたまま)", () => {
    const plan: MediaPlan = {
      hero: null,
      sections: [
        { heading: "見出し1", media: null },
        { heading: "見出し2", media: { kind: "asset", assetId: "asset-2" } },
      ],
    };
    const rows = planToRows(plan);
    // sortOrder は plan.sections 内の位置(1始まり)。抜けた節があっても詰めない(既存 media route と同じ挙動)。
    expect(rows).toEqual([{ slot: "section", heading: "見出し2", assetId: "asset-2", figureKind: null, sortOrder: 2 }]);
    expect(rowsToPlan(rows)).toEqual({
      hero: null,
      sections: [{ heading: "見出し2", media: { kind: "asset", assetId: "asset-2" } }],
    });
  });
});
