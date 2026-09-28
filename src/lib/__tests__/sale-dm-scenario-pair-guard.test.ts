/**
 * 「DMの種類」で組んだ発送(dm_campaigns.default_scenario_id が入っている)では、画面を通さず
 * 個別APIを叩いて型の割当・追加・削除・写した型の変更をされると、手紙とLPの組が壊れる
 * (設計 2026-09-27 §3.4)。組を書き換えうる既存route 7本すべてで断ることを実測する。
 *
 * ⚠route 名を手で並べない走査を2本持つ(下の「組を書き換えうる7 route はすべて…」と
 * 「宛先の型の組を書き換える route の機械的な洗い出し」の各 describe)。後者は sale-dm 配下で
 * 「宛先の variantId/lpVariantId を書き換える」route を正規表現(data書込み・shorthand・生SQL・
 * 型行そのものの create/delete)で拾い、一覧が増えたら落ちる(controller ruling: 作成route
 * (campaigns/route.ts) と Task 5 の新route は allow-list)。この2本の正規表現自体の自己検査
 * (拾いたい形/拾いたくない形)は「正規表現の自己検査」describe に持つ。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { vi } from "vitest";

// ---- 純関数(assertNotScenarioCampaign / assertNotScenarioVariant) ----
import { assertNotScenarioCampaign, assertNotScenarioVariant } from "@/lib/sale-dm-letter/scenario-campaign-guard";

describe("assertNotScenarioCampaign / assertNotScenarioVariant(純関数)", () => {
  it("種類つきの発送(defaultScenarioId あり)は 409 SCENARIO_CAMPAIGN_LOCKED", () => {
    try {
      assertNotScenarioCampaign({ defaultScenarioId: "s1" });
      expect.unreachable();
    } catch (e) {
      expect((e as { status: number; code: string }).status).toBe(409);
      expect((e as { status: number; code: string }).code).toBe("SCENARIO_CAMPAIGN_LOCKED");
    }
  });
  it("種類なしの発送(defaultScenarioId=null)は何もしない", () => {
    expect(() => assertNotScenarioCampaign({ defaultScenarioId: null })).not.toThrow();
  });
  it("写した型(scenarioId あり)は 409 SCENARIO_VARIANT_LOCKED", () => {
    try {
      assertNotScenarioVariant({ scenarioId: "s1" });
      expect.unreachable();
    } catch (e) {
      expect((e as { status: number; code: string }).status).toBe(409);
      expect((e as { status: number; code: string }).code).toBe("SCENARIO_VARIANT_LOCKED");
    }
  });
  it("写していない型(scenarioId=null)は何もしない", () => {
    expect(() => assertNotScenarioVariant({ scenarioId: null })).not.toThrow();
  });
});

// ---- route ごとの振る舞い(実際に叩いて 409・書き込みゼロ回 を実測) ----
vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response { static json = (b: unknown, init?: ResponseInit) => Response.json(b, init); }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
vi.mock("@/generated/prisma", () => ({ Prisma: { DbNull: Symbol("DbNull") } }));
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error { status: number; code: string; constructor(s: number, m: string, c = "ERROR") { super(m); this.status = s; this.code = c; } }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(), getUserPermissions: vi.fn(), getOwnerDisplayConfig: vi.fn(),
    parseJsonBody: vi.fn(async (r: Request) => { const t = await r.text(); return t ? JSON.parse(t) : {}; }),
    handleApiError: vi.fn((e: unknown) => e instanceof MockApiError ? Response.json({ error: { message: e.message, code: e.code } }, { status: e.status }) : Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 })),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    dmCampaign: { findFirst: vi.fn(), findUnique: vi.fn() },
    dmVariant: { findFirst: vi.fn(), findMany: vi.fn(async () => []), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(async () => ({ count: 0 })), deleteMany: vi.fn() },
    dmLpVariant: { findFirst: vi.fn(), findMany: vi.fn(async () => []), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(async () => ({ count: 0 })), deleteMany: vi.fn() },
    dmLpVariantMedia: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    dmRecipientDraft: { findUnique: vi.fn(), findMany: vi.fn(async () => []), count: vi.fn(async () => 0), updateMany: vi.fn(async () => ({ count: 0 })) },
    property: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => []),
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { default: db };
});

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { PATCH as patchDraft } from "../../app/api/properties/sale-dm/drafts/[id]/route";
import { POST as assign } from "../../app/api/properties/sale-dm/campaigns/[id]/assign/route";
import { POST as createVariant } from "../../app/api/properties/sale-dm/campaigns/[id]/variants/route";
import { POST as createLpVariant } from "../../app/api/properties/sale-dm/campaigns/[id]/lp-variants/route";
import { PATCH as patchVariant, DELETE as deleteVariant } from "../../app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/route";
import { PATCH as patchLpVariant, DELETE as deleteLpVariant } from "../../app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  dmCampaign: { findFirst: Fn; findUnique: Fn };
  dmVariant: { findFirst: Fn; findMany: Fn; create: Fn; update: Fn; updateMany: Fn; deleteMany: Fn };
  dmLpVariant: { findFirst: Fn; findMany: Fn; create: Fn; update: Fn; updateMany: Fn; deleteMany: Fn };
  dmLpVariantMedia: { deleteMany: Fn };
  dmRecipientDraft: { findUnique: Fn; findMany: Fn; count: Fn; updateMany: Fn };
  $queryRaw: Fn;
};

const READS = ["property", "csv_export", "csv_export_personal", "owner"];
const optionFields = { designTemplate: "formal", tone: "formal", length: "medium", appeal: "price", strength: "low" };
const lpOptionFields = { tone: "formal", length: "medium", appeal: "price", strength: "low" };
const req = (method: string, body?: unknown) =>
  new Request("http://x", { method, body: body === undefined ? undefined : JSON.stringify(body) }) as never;
const ctxC = { params: Promise.resolve({ id: "c1" }) };
const ctxV = { params: Promise.resolve({ id: "c1", variantId: "v1" }) };
const ctxLp = { params: Promise.resolve({ id: "c1", lpId: "l1" }) };
const ctxD = { params: Promise.resolve({ id: "d1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Fn).mockResolvedValue([
    ...READS.map((r) => ({ resource: r, action: "read", granted: true })),
    { resource: "property", action: "write", granted: true },
  ]);
  (getOwnerDisplayConfig as Fn).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
  pm.dmCampaign.findFirst.mockResolvedValue({ id: "c1" });
});

describe("drafts/[id] PATCH: variantId 指定時のみ種類つきの発送を断る", () => {
  it("種類つきの発送で variantId を付け替えようとすると 409・書き込みゼロ", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      id: "d1", campaignId: "c1", status: "draft",
      campaign: { createdBy: "u1", defaultScenarioId: "s1" },
    });
    const res = await patchDraft(req("PATCH", { variantId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11" }) as never, ctxD);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("SCENARIO_CAMPAIGN_LOCKED");
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
    expect(pm.dmVariant.findFirst).not.toHaveBeenCalled();
  });
  it("種類つきの発送でも本文(body)だけの手直しは通る(組を壊さない編集)", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      id: "d1", campaignId: "c1", status: "draft",
      campaign: { createdBy: "u1", defaultScenarioId: "s1" },
    });
    pm.dmRecipientDraft.updateMany.mockResolvedValue({ count: 1 });
    const res = await patchDraft(req("PATCH", { body: "本文だけ" }) as never, ctxD);
    expect(res.status).toBe(200);
  });
  it("種類つきの発送でも override だけの手直しは通る", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      id: "d1", campaignId: "c1", status: "draft",
      campaign: { createdBy: "u1", defaultScenarioId: "s1" },
    });
    pm.dmRecipientDraft.updateMany.mockResolvedValue({ count: 1 });
    const res = await patchDraft(req("PATCH", { override: { tone: "soft" } }) as never, ctxD);
    expect(res.status).toBe(200);
  });
});

describe("campaigns/[id]/assign POST: 種類つきの発送は割当を全面で断る", () => {
  it("種類つきの発送で 409・宛先の書き込みゼロ", async () => {
    pm.dmCampaign.findUnique.mockResolvedValue({ defaultScenarioId: "s1" });
    const res = await assign(req("POST", { mode: "auto" }) as never, ctxC);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("SCENARIO_CAMPAIGN_LOCKED");
    expect(pm.dmVariant.findMany).not.toHaveBeenCalled();
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });
  it("種類なしの発送は従来どおり通る", async () => {
    pm.dmCampaign.findUnique.mockResolvedValue({ defaultScenarioId: null });
    pm.dmVariant.findMany.mockResolvedValue([{ id: "vA" }]);
    pm.dmRecipientDraft.findMany.mockResolvedValue([]);
    const res = await assign(req("POST", { mode: "auto" }) as never, ctxC);
    expect(res.status).toBe(200);
  });
});

describe("campaigns/[id]/variants POST(作成): 種類つきの発送は型の追加を断る", () => {
  it("種類つきの発送で 409・作成ゼロ", async () => {
    pm.dmCampaign.findUnique.mockResolvedValue({ id: "c1", createdBy: "u1", defaultScenarioId: "s1" });
    const res = await createVariant(req("POST", { label: "B", options: optionFields }) as never, ctxC);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("SCENARIO_CAMPAIGN_LOCKED");
    expect(pm.dmVariant.create).not.toHaveBeenCalled();
  });
});

describe("campaigns/[id]/lp-variants POST(作成): 種類つきの発送は型の追加を断る", () => {
  it("種類つきの発送で 409・作成ゼロ", async () => {
    pm.dmCampaign.findUnique.mockResolvedValue({ id: "c1", createdBy: "u1", defaultScenarioId: "s1" });
    const res = await createLpVariant(req("POST", { label: "B", options: lpOptionFields }) as never, ctxC);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("SCENARIO_CAMPAIGN_LOCKED");
    expect(pm.dmLpVariant.create).not.toHaveBeenCalled();
  });
});

describe("campaigns/[id]/variants/[variantId] PATCH: 写した型は変更できない", () => {
  const cases: Array<[string, unknown]> = [
    ["label", { label: "新ラベル" }],
    ["lpUrl", { lpUrl: "https://lp-new.example.com" }],
    ["options.tone", { options: { tone: "soft" } }],
  ];
  for (const [name, body] of cases) {
    it(`${name} だけの変更でも 409・更新ゼロ`, async () => {
      pm.dmVariant.findFirst.mockResolvedValue({ id: "v1", ...optionFields, extraInstruction: null, scenarioId: "s1" });
      const res = await patchVariant(req("PATCH", body) as never, ctxV);
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe("SCENARIO_VARIANT_LOCKED");
      expect(pm.dmVariant.update).not.toHaveBeenCalled();
    });
  }
  it("写していない型(scenarioId=null)は従来どおり変更できる", async () => {
    pm.dmVariant.findFirst.mockResolvedValue({ id: "v1", ...optionFields, extraInstruction: null, scenarioId: null });
    pm.dmRecipientDraft.count.mockResolvedValue(0);
    pm.dmVariant.update.mockResolvedValue({ id: "v1", label: "A2", ...optionFields });
    const res = await patchVariant(req("PATCH", { label: "A2" }) as never, ctxV);
    expect(res.status).toBe(200);
  });
});

describe("campaigns/[id]/variants/[variantId] DELETE: 種類つきの発送は型の削除を断る", () => {
  it("種類つきの発送で 409・削除ゼロ", async () => {
    pm.dmVariant.findFirst.mockResolvedValue({ id: "v1", campaign: { defaultScenarioId: "s1" } });
    const res = await deleteVariant(req("DELETE") as never, ctxV);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("SCENARIO_CAMPAIGN_LOCKED");
    expect(pm.dmVariant.deleteMany).not.toHaveBeenCalled();
  });
});

describe("campaigns/[id]/lp-variants/[lpId] PATCH: 写した型は変更できない", () => {
  const cases: Array<[string, unknown]> = [
    ["label", { label: "新ラベル" }],
    ["options.tone", { options: { tone: "soft" } }],
  ];
  for (const [name, body] of cases) {
    it(`${name} だけの変更でも 409・更新ゼロ`, async () => {
      pm.dmLpVariant.findFirst.mockResolvedValue({ id: "l1", campaignId: "c1", ...lpOptionFields, templateFrozenAt: null, scenarioId: "s1" });
      const res = await patchLpVariant(req("PATCH", body) as never, ctxLp);
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe("SCENARIO_VARIANT_LOCKED");
      expect(pm.dmLpVariant.update).not.toHaveBeenCalled();
    });
  }
});

describe("campaigns/[id]/lp-variants/[lpId] DELETE: 種類つきの発送は型の削除を断る(宛先を外す付け替えを伴うため)", () => {
  it("種類つきの発送で 409・detach も削除もゼロ", async () => {
    pm.dmLpVariant.findFirst.mockResolvedValue({ templateFrozenAt: null, campaign: { defaultScenarioId: "s1" } });
    const res = await deleteLpVariant(req("DELETE") as never, ctxLp);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("SCENARIO_CAMPAIGN_LOCKED");
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
    expect(pm.dmLpVariant.deleteMany).not.toHaveBeenCalled();
  });
});

// ---- 走査1: 組を書き換えうる route 7本すべてに、いずれかのガード呼び出しがある ----
// ⚠variants/[variantId] と lp-variants/[lpId] は PATCH/DELETE の2 handler を1ファイルに
//   持つ(Minor 1)。ファイル全体に「どちらかの文字列がある」だけでは、片方の handler だけに
//   ガードが残り、もう片方から削れても検査が気づかない。handler ごとに source を切り出し、
//   PATCH には assertNotScenarioVariant(・DELETE には assertNotScenarioCampaign( を要求する。
describe("組を書き換えうる7 route はすべて共通ガードを呼ぶ(handler単位)", () => {
  const ROOT = path.resolve(process.cwd(), "src/app/api/properties/sale-dm");
  const HANDLER_GUARDS: Array<{ file: string; handler: "PATCH" | "POST" | "DELETE"; guard: string }> = [
    { file: "src/app/api/properties/sale-dm/drafts/[id]/route.ts", handler: "PATCH", guard: "assertNotScenarioCampaign(" },
    { file: "src/app/api/properties/sale-dm/campaigns/[id]/assign/route.ts", handler: "POST", guard: "assertNotScenarioCampaign(" },
    { file: "src/app/api/properties/sale-dm/campaigns/[id]/variants/route.ts", handler: "POST", guard: "assertNotScenarioCampaign(" },
    { file: "src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/route.ts", handler: "POST", guard: "assertNotScenarioCampaign(" },
    { file: "src/app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/route.ts", handler: "PATCH", guard: "assertNotScenarioVariant(" },
    { file: "src/app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/route.ts", handler: "DELETE", guard: "assertNotScenarioCampaign(" },
    { file: "src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/route.ts", handler: "PATCH", guard: "assertNotScenarioVariant(" },
    { file: "src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/route.ts", handler: "DELETE", guard: "assertNotScenarioCampaign(" },
  ];

  // 指定 handler のソースだけを切り出す(次の export async function の手前まで、無ければ末尾まで)。
  function handlerSlice(src: string, handler: string): string {
    const start = src.indexOf(`export async function ${handler}`);
    if (start === -1) return "";
    const next = src.indexOf("export async function", start + 1);
    return next === -1 ? src.slice(start) : src.slice(start, next);
  }

  it("走査対象が実在する(0件なら検査が空振り)", () => {
    expect(readdirSync(ROOT).length).toBeGreaterThan(0);
  });

  for (const { file, handler, guard } of HANDLER_GUARDS) {
    it(`${file} ${handler}: ${guard} を呼ぶ`, () => {
      const src = readFileSync(path.resolve(process.cwd(), file), "utf-8");
      const slice = handlerSlice(src, handler);
      expect(slice.length, `${file} に export async function ${handler} が見つからない`).toBeGreaterThan(0);
      expect(slice.includes(guard), `${file} の ${handler} が ${guard} を呼んでいない`).toBe(true);
    });
  }
});

// ---- 走査2で使う正規表現(自己検査でも production の走査でも同じ定数を参照する) ----
// (a) 宛先の variantId/lpVariantId を data に書く形。明示key・shorthand・`data.xxx = `代入を拾う。
//     ⚠前方一致のみ(`data` から後ろだけを見る)。`where: { variantId }` のような読み取り専用の
//     フィルタは、その後ろに(同じ書込み呼び出しの)`data` が続いて初めて拾われる。単体の
//     `where` だけの行を「書込み」と誤検出しない設計(後述の自己検査で固定)。
const DATA_KEY_WRITE = /\bdata\s*[:.]\s*\{?[\s\S]{0,200}?\b(variantId|lpVariantId)\b\s*[:,}=]/;
// (b) 生SQL(`$queryRaw`)で variant_id/lp_variant_id を UPDATE ... SET する形。
const RAW_SQL_WRITE = /\bUPDATE\b[\s\S]{0,200}?\bSET\b[\s\S]{0,200}?\b(variant_id|lp_variant_id)\b/i;
// (c) 型の行そのものの作成/削除(dmVariant/dmLpVariant の create・createMany・delete・deleteMany)。
//     campaigns/** 配下限定(brief指定)。dmLpVariantMedia のような別モデルは拾わない
//     (`Variant\.` で終端を固定するため `VariantMedia.` は一致しない)。
const CREATE_DELETE_VARIANT_ROW = /\bdm(Lp)?Variant\.(create|createMany|delete|deleteMany)\b/;

// ---- 正規表現の自己検査(拾いたい形/拾いたくない形を先に固定する) ----
// レビュー指摘: 「拾わない正規表現」は常に緑になり検査が空振りする。まずサンプル文字列に対して
// 期待どおり拾える/拾わないことを固定してから、実ファイルの走査に使う。
describe("正規表現の自己検査(拾いたい形・拾いたくない形)", () => {
  describe("DATA_KEY_WRITE", () => {
    const positives = [
      ["明示key", 'data: { variantId: v1, body: "" }'],
      ["shorthand(カンマ区切り)", 'data: { variantId, body: "" }'],
      ["shorthand(閉じ括弧の直前)", "data: { lpVariantId }"],
      ["data.xxx = 代入", "data.variantId = parsed.variantId;"],
      ["lpVariantId を null に戻す", "data: { lpVariantId: null }"],
    ] as const;
    for (const [name, sample] of positives) {
      it(`拾う: ${name}`, () => expect(DATA_KEY_WRITE.test(sample)).toBe(true));
    }
    const negatives = [
      ["where だけ(data が無い)", "where: { variantId: v1 }"],
      ["select だけ(data が無い)", "select: { variantId: true, lpVariantId: true }"],
      [
        "where の variantId と無関係な data(where→data の順で、data 側にキーが無い)",
        "where: { variantId: v1 }, data: { label: x }",
      ],
    ] as const;
    for (const [name, sample] of negatives) {
      it(`拾わない: ${name}`, () => expect(DATA_KEY_WRITE.test(sample)).toBe(false));
    }
  });

  describe("RAW_SQL_WRITE", () => {
    it("拾う: UPDATE ... SET variant_id", () =>
      expect(RAW_SQL_WRITE.test("await tx.$queryRaw`UPDATE dm_recipient_drafts SET variant_id = ${v} WHERE id = ${id}`;")).toBe(true));
    it("拾う: UPDATE ... SET lp_variant_id", () =>
      expect(RAW_SQL_WRITE.test("UPDATE dm_recipient_drafts SET lp_variant_id = NULL WHERE id = $1")).toBe(true));
    it("拾わない: 読み取りだけの SELECT", () =>
      expect(RAW_SQL_WRITE.test("SELECT variant_id FROM dm_recipient_drafts WHERE id = ${id}")).toBe(false));
  });

  describe("CREATE_DELETE_VARIANT_ROW", () => {
    it("拾う: dmVariant.create", () => expect(CREATE_DELETE_VARIANT_ROW.test("await tx.dmVariant.create({ data: {} })")).toBe(true));
    it("拾う: dmLpVariant.deleteMany", () => expect(CREATE_DELETE_VARIANT_ROW.test("await tx.dmLpVariant.deleteMany({ where: {} })")).toBe(true));
    it("拾わない: 別モデル dmLpVariantMedia", () =>
      expect(CREATE_DELETE_VARIANT_ROW.test("await tx.dmLpVariantMedia.deleteMany({ where: {} })")).toBe(false));
    it("拾わない: update(型の設定変更は対象外・create/delete のみ)", () =>
      expect(CREATE_DELETE_VARIANT_ROW.test("await tx.dmVariant.update({ data: {} })")).toBe(false));
  });
});

// ---- 走査2: 宛先の型の組を書き換える route を正規表現で拾う ----
// ⚠route 名を手で並べない。将来route が増えて拾われたら、allow-list(作成route + Task 5)に
//   無い限り、ガード漏れとして落ちる(controller ruling)。DATA_KEY_WRITE/RAW_SQL_WRITE は
//   sale-dm 配下全体、CREATE_DELETE_VARIANT_ROW は campaigns/** 配下限定(brief指定)。
describe("宛先の型の組を書き換える route の機械的な洗い出し", () => {
  const ROOT = path.resolve(process.cwd(), "src/app/api/properties/sale-dm");
  const CAMPAIGNS_ROOT = path.join(ROOT, "campaigns");
  function routeFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) return routeFiles(p);
      return name === "route.ts" ? [p] : [];
    });
  }

  // 作成route(初めて組む・共通手順 attachScenario 経由=Task 3 走査が別途固定)と、
  // Task 5(種類を変える・共通手順 attachScenario+isValidScenarioPair 経由=shared-steps 走査が別途固定)。
  const ALLOWED_WITHOUT_GUARD = new Set([
    "src/app/api/properties/sale-dm/campaigns/route.ts",
    "src/app/api/properties/sale-dm/campaigns/[id]/properties/[propertyId]/scenario/route.ts",
  ]);

  const ALL_FILES = routeFiles(ROOT);
  const CAMPAIGNS_FILES = new Set(routeFiles(CAMPAIGNS_ROOT));

  it("走査できている(0件なら検査が空振り)", () => {
    expect(ALL_FILES.length).toBeGreaterThan(5);
  });

  function isWriter(f: string): boolean {
    const s = readFileSync(f, "utf-8");
    if (DATA_KEY_WRITE.test(s) || RAW_SQL_WRITE.test(s)) return true;
    // 型行そのものの create/delete は campaigns/** 限定(brief指定)。
    return CAMPAIGNS_FILES.has(f) && CREATE_DELETE_VARIANT_ROW.test(s);
  }

  const writers = ALL_FILES.filter(isWriter).map((f) => path.relative(process.cwd(), f).replace(/\\/g, "/"));

  it("拾えている(0件なら検査が空振り)", () => {
    expect(writers.length).toBeGreaterThan(0);
  });

  // レビュー指摘の再発防止: 旧正規表現(shorthand/生SQL/create-delete を見ない)では
  // assign の主な書込み(:178 `data: { variantId, ... }`・:191 `data: { lpVariantId }`)や、
  // 型の作成/削除ルート(variants・lp-variants の POST/DELETE)が拾われていなかった。
  // 現行の3正規表現の和集合で、組を書き換えうる7 route + 作成route の**全8本**が拾えることを固定する。
  it("組を書き換えうる7 route + 作成route の全8本が拾われている(regression固定)", () => {
    const expected = [
      "src/app/api/properties/sale-dm/campaigns/route.ts",
      // 種類を変える(Task 5)も書き手として拾われる(allow-list で通す=拾えていないと allow-list が空振り)。
      "src/app/api/properties/sale-dm/campaigns/[id]/properties/[propertyId]/scenario/route.ts",
      "src/app/api/properties/sale-dm/campaigns/[id]/assign/route.ts",
      "src/app/api/properties/sale-dm/campaigns/[id]/variants/route.ts",
      "src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/route.ts",
      "src/app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/route.ts",
      "src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/route.ts",
      "src/app/api/properties/sale-dm/drafts/[id]/route.ts",
    ];
    for (const rel of expected) expect(writers, `${rel} が拾われていない`).toContain(rel);
  });

  it("拾った route はすべて allow-list かガード呼び出しを持つ", () => {
    for (const rel of writers) {
      if (ALLOWED_WITHOUT_GUARD.has(rel)) continue;
      const s = readFileSync(path.resolve(process.cwd(), rel), "utf-8");
      expect(
        s.includes("assertNotScenarioCampaign(") || s.includes("assertNotScenarioVariant("),
        `${rel} が種類つきの発送を断っていない(新規route の付け忘れ)`,
      ).toBe(true);
    }
  });

  it("未知の route が増えていない(allow-list 以外はここに挙げた集合に収まる)", () => {
    const known = new Set([
      "src/app/api/properties/sale-dm/campaigns/route.ts",
      "src/app/api/properties/sale-dm/campaigns/[id]/assign/route.ts",
      "src/app/api/properties/sale-dm/campaigns/[id]/variants/route.ts",
      "src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/route.ts",
      "src/app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/route.ts",
      "src/app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/route.ts",
      "src/app/api/properties/sale-dm/drafts/[id]/route.ts",
    ]);
    for (const rel of writers) {
      expect(known.has(rel) || ALLOWED_WITHOUT_GUARD.has(rel), `未知の route: ${rel}`).toBe(true);
    }
  });
});

// ---- Minor 4: 文面の貼り直し(template PUT)・LPの写真と図(media PUT)・適用(apply) は
//      種類つきの発送でも断らない(走査で固定はしない=触らない・ここでは実測のみ)。
//      「通ることを固定しない」と brief にあるため、200 までは求めず、少なくとも
//      SCENARIO_CAMPAIGN_LOCKED / SCENARIO_VARIANT_LOCKED を返さないことだけを実測する。
describe("template PUT / media PUT / apply は種類つきの発送でも断らない", () => {
  const SCENARIO_CODES = new Set(["SCENARIO_CAMPAIGN_LOCKED", "SCENARIO_VARIANT_LOCKED"]);
  async function codeOf(res: Response): Promise<string | undefined> {
    const json = await res.json();
    return json?.error?.code;
  }

  it("variants/[variantId]/template PUT: 写した型(scenarioId あり)でも SCENARIO_* を返さない", async () => {
    const { PUT: putTemplate } = await import("../../app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/template/route");
    pm.dmVariant.findFirst.mockResolvedValue({
      id: "v1", ...optionFields, templateFrozenAt: null, bodyTemplate: "旧本文", scenarioId: "s1",
    });
    pm.dmRecipientDraft.count.mockResolvedValue(0);
    const res = await putTemplate(
      req("PUT", { body: "新本文", promptDigest: "a".repeat(64), baseBodyDigest: "b".repeat(64) }) as never,
      ctxV,
    );
    const code = await codeOf(res);
    expect(code === undefined || !SCENARIO_CODES.has(code)).toBe(true);
  });

  it("lp-variants/[lpId]/media PUT: 写した型(scenarioId あり)でも SCENARIO_* を返さない", async () => {
    const { PUT: putMedia } = await import("../../app/api/properties/sale-dm/campaigns/[id]/lp-variants/[lpId]/media/route");
    pm.dmLpVariant.findFirst.mockResolvedValue({ id: "l1", bodyText: "", templateFrozenAt: null, scenarioId: "s1" });
    const res = await putMedia(req("PUT", { hero: null, sections: [] }) as never, ctxLp);
    const code = await codeOf(res);
    expect(code === undefined || !SCENARIO_CODES.has(code)).toBe(true);
  });

  it("variants/[variantId]/apply POST: 種類つきの発送(defaultScenarioId あり)でも SCENARIO_* を返さない", async () => {
    const { POST: applyVariant } = await import("../../app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/apply/route");
    pm.dmVariant.findFirst.mockResolvedValue({ id: "v1", bodyTemplate: "本文", scenarioId: "s1" });
    pm.dmRecipientDraft.findMany.mockResolvedValue([]);
    const res = await applyVariant(req("POST", { bodyDigest: "c".repeat(64) }) as never, ctxV);
    const code = await codeOf(res);
    expect(code === undefined || !SCENARIO_CODES.has(code)).toBe(true);
  });
});
