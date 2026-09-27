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
    $queryRaw: vi.fn(async () => [{ id: "s1", deleted_at: null }]),
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { default: db };
});

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { GET } from "../../app/api/properties/sale-dm/scenarios/[id]/prompt/route";
import { PUT } from "../../app/api/properties/sale-dm/scenarios/[id]/template/route";
import {
  buildExternalPrompt,
  promptDigest,
  bodyTemplateDigest,
} from "../sale-dm-letter/external-prompt";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  dmScenario: { findFirst: Fn; findUniqueOrThrow: Fn; update: Fn };
  $queryRaw: Fn;
};

const SID = "33333333-3333-4333-8333-333333333333";
const ctx = { params: Promise.resolve({ id: SID }) };

const SETTINGS = { tone: "formal", length: "medium", appeal: "price", strength: "medium" };
const DIGEST = promptDigest(buildExternalPrompt(SETTINGS));

const scenarioRow = (over: Record<string, unknown> = {}) => ({
  id: SID,
  name: "既存の種類",
  autoKey: null,
  sortOrder: 10,
  active: true,
  designTemplate: "formal",
  ...SETTINGS,
  extraInstruction: null,
  letterPromptText: "指示文",
  letterBodyTemplate: "本文",
  deletedAt: null,
  ...over,
});

const req = (method: string, body?: unknown) =>
  new Request("http://x", { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

/** PUT の baseBodyDigest は既定で「今の保存済み原本」に合わせて自動で入れる。ずれを試す
 *  テストだけ明示で上書きする。 */
const put = (b: Record<string, unknown>, baseBody: string | null = "本文") =>
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
  pm.$queryRaw.mockResolvedValue([{ id: SID, deleted_at: null }]);
});

describe("GET /scenarios/[id]/prompt(台帳の手紙の指示文)", () => {
  it("書き方の設定のどれかが未設定 → 400 SCENARIO_SETTINGS_INCOMPLETE", async () => {
    pm.dmScenario.findFirst.mockResolvedValue(scenarioRow({ tone: null }));
    const res = await GET(req("GET"), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("SCENARIO_SETTINGS_INCOMPLETE");
  });

  it("buildExternalPrompt の結果と、その指紋・原本の指紋・原本を返す", async () => {
    pm.dmScenario.findFirst.mockResolvedValue(scenarioRow({ letterBodyTemplate: null }));
    const res = await GET(req("GET"), ctx);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.prompt).toBe(buildExternalPrompt(SETTINGS));
    expect(j.digest).toBe(DIGEST);
    expect(j.bodyDigest).toBe(bodyTemplateDigest(null));
    expect(j.body).toBeNull();
  });

  it("削除済み/存在しない → 404 SCENARIO_NOT_FOUND", async () => {
    pm.dmScenario.findFirst.mockResolvedValue(null);
    const res = await GET(req("GET"), ctx);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("SCENARIO_NOT_FOUND");
  });
});

describe("PUT /scenarios/[id]/template(台帳の手紙の原本の貼り戻し)", () => {
  it("同じ本文 → changed:false・update は呼ばない", async () => {
    const res = await PUT(put({ body: "本文", promptDigest: DIGEST }), ctx);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.changed).toBe(false);
    expect(j.bodyDigest).toBe(bodyTemplateDigest("本文"));
    expect(pm.dmScenario.update).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("書き方の設定が変わっていたら 409 PROMPT_STALE(Review Focus 4)", async () => {
    const res = await PUT(put({ body: "新しい本文", promptDigest: "0".repeat(64) }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("PROMPT_STALE");
    expect(pm.dmScenario.update).not.toHaveBeenCalled();
  });

  it("見えていた原本(baseBodyDigest)が今と違う → 409 TEMPLATE_STALE", async () => {
    const res = await PUT(
      put({ body: "新しい本文", promptDigest: DIGEST }, "開いたときは別の本文だった"),
      ctx,
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("TEMPLATE_STALE");
    expect(pm.dmScenario.update).not.toHaveBeenCalled();
  });

  it("未知のタグが残っている本文 → 400 INVALID_BODY", async () => {
    const res = await PUT(put({ body: "{{所有者名}}", promptDigest: DIGEST }), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_BODY");
    expect(pm.dmScenario.update).not.toHaveBeenCalled();
  });

  it("正常: 台帳行を FOR UPDATE してから保存し、監査は文字数だけ", async () => {
    const res = await PUT(put({ body: "拝啓 新しい本文", promptDigest: DIGEST }), ctx);
    expect(res.status).toBe(200);
    expect(String(pm.$queryRaw.mock.calls[0][0])).toContain("FOR UPDATE");
    expect(pm.dmScenario.update).toHaveBeenCalledWith({
      where: { id: SID },
      data: { letterBodyTemplate: "拝啓 新しい本文", letterPromptText: buildExternalPrompt(SETTINGS) },
    });
    expect(writeAuditLog).toHaveBeenCalledWith({
      userId: "u1",
      action: "sale_dm_scenario_letter_template",
      targetTable: "dm_scenarios",
      targetId: SID,
      detail: { length: "拝啓 新しい本文".length },
    });
    const j = await res.json();
    expect(j.changed).toBe(true);
    expect(j.bodyDigest).toBe(bodyTemplateDigest("拝啓 新しい本文"));
  });

  it("削除済み → 404 SCENARIO_NOT_FOUND・保存しない", async () => {
    pm.$queryRaw.mockResolvedValue([{ id: SID, deleted_at: new Date() }]);
    const res = await PUT(put({ body: "本文", promptDigest: DIGEST }), ctx);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("SCENARIO_NOT_FOUND");
    expect(pm.dmScenario.update).not.toHaveBeenCalled();
  });

  it("管理者以外は 403・処理に入らない", async () => {
    (getUserPermissions as Fn).mockResolvedValue([{ resource: "property", action: "write", granted: true }]);
    const res = await PUT(put({ body: "本文", promptDigest: DIGEST }), ctx);
    expect(res.status).toBe(403);
    expect(pm.dmScenario.update).not.toHaveBeenCalled();
  });
});
