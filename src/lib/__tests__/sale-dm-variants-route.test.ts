import { vi } from "vitest";
vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response { static json = (b: unknown, init?: ResponseInit) => Response.json(b, init); }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error { status: number; code: string; constructor(s: number, m: string, c = "ERROR") { super(m); this.status = s; this.code = c; } }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(), getUserPermissions: vi.fn(), getOwnerDisplayConfig: vi.fn(),
    parseJsonBody: vi.fn(async (r: Request) => { const t = await r.text(); return t ? JSON.parse(t) : {}; }),
    // Resolution A: mirror real handleApiError — ZodError (has issues array) → 422, MockApiError → status, else 500
    handleApiError: vi.fn((e: unknown) => {
      if (e instanceof MockApiError) return Response.json({ error: { message: e.message, code: e.code } }, { status: e.status });
      if (e !== null && typeof e === "object" && "issues" in e && Array.isArray((e as Record<string, unknown>).issues)) {
        return Response.json({ error: { code: "VALIDATION_ERROR" } }, { status: 422 });
      }
      return Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 });
    }),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    dmCampaign: { findUnique: vi.fn(), findFirst: vi.fn() },
    dmVariant: { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn(async () => ({ count: 0 })) },
    dmRecipientDraft: { count: vi.fn(), updateMany: vi.fn(), findMany: vi.fn(async () => []) },
  };
  // $transaction はコールバックに同じ db を tx として渡す(tx.* === pm.* なので既存アサーションがそのまま効く)。
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  // mark-sent との直列化用の行ロック(FOR UPDATE)。結果は使わない。
  db.$queryRaw = vi.fn(async () => []);
  return { default: db };
});

import { describe, it, expect, beforeEach } from "vitest";
import prismaMock from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { GET as listVariants, POST as createVariant } from "../../app/api/properties/sale-dm/campaigns/[id]/variants/route";
import { PATCH as updateVariant, DELETE as deleteVariant } from "../../app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/route";
import { saleDmCampaignBodySchema } from "@/lib/validators-sale-dm";

const pm = prismaMock as never as {
  dmCampaign: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  dmVariant: { findMany: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  dmRecipientDraft: { count: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  $queryRaw: ReturnType<typeof vi.fn>;
};
const ALL = ["property", "csv_export", "csv_export_personal", "owner"];
const grant = (...keys: string[]) =>
  (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(
    [...keys.map((k) => ({ resource: k, action: "read", granted: true })), { resource: "property", action: "write", granted: true }],
  );
const optionFields = { designTemplate: "formal", tone: "formal", length: "medium", appeal: "price", strength: "low" };
const ctxC = { params: Promise.resolve({ id: "c1" }) };
const ctxV = { params: Promise.resolve({ id: "c1", variantId: "v1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1" });
  (getOwnerDisplayConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
  grant(...ALL);
  // assertSaleDmCampaignOwned 用: 既定で作成者本人のキャンペーン(owned)。
  pm.dmCampaign.findFirst.mockResolvedValue({ id: "c1" });
  // 既定で型は当該キャンペーンに存在する(存在チェック通過)。既存 option 値も返す(送信値との差分判定用)。
  pm.dmVariant.findFirst.mockResolvedValue({ id: "v1", ...optionFields, extraInstruction: null });
  pm.dmRecipientDraft.updateMany.mockResolvedValue({ count: 0 });
});

describe("GET variants", () => {
  it("権限ありで 200・no-store・型一覧を返す", async () => {
    pm.dmVariant.findMany.mockResolvedValue([{ id: "v1", label: "A", ...optionFields }]);
    const res = await listVariants(new Request("http://x") as never, ctxC);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const json = await res.json();
    expect(json.variants).toHaveLength(1);
  });
  it("権限不足で 403", async () => {
    grant("property");
    const res = await listVariants(new Request("http://x") as never, ctxC);
    expect(res.status).toBe(403);
  });
});

describe("POST variant (作成)", () => {
  it("label + options 一式で作成し 200", async () => {
    pm.dmCampaign.findUnique.mockResolvedValue({ id: "c1", createdBy: "u1" });
    pm.dmVariant.create.mockResolvedValue({ id: "v2", label: "B", ...optionFields });
    const res = await createVariant(new Request("http://x", { method: "POST", body: JSON.stringify({ label: "B", options: optionFields }) }) as never, ctxC);
    expect(res.status).toBe(200);
    expect(pm.dmVariant.create).toHaveBeenCalled();
    const arg = pm.dmVariant.create.mock.calls[0][0];
    expect(arg.data.campaignId).toBe("c1");
    expect(arg.data.label).toBe("B");
    expect(arg.data.tone).toBe("formal");
  });
  it("存在しない campaign で 404", async () => {
    pm.dmCampaign.findUnique.mockResolvedValue(null);
    const res = await createVariant(new Request("http://x", { method: "POST", body: JSON.stringify({ label: "B", options: optionFields }) }) as never, ctxC);
    expect(res.status).toBe(404);
  });
  it("作成の監査 detail に label(自由記述)を保存しない(PII混入防止・targetId で追跡)", async () => {
    pm.dmCampaign.findUnique.mockResolvedValue({ id: "c1", createdBy: "u1" });
    pm.dmVariant.create.mockResolvedValue({ id: "v2", label: "田中一郎", ...optionFields });
    await createVariant(new Request("http://x", { method: "POST", body: JSON.stringify({ label: "田中一郎", options: optionFields }) }) as never, ctxC);
    const detail = (writeAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0].detail;
    expect(detail.label).toBeUndefined();
    expect(detail.campaignId).toBe("c1");
  });
  it("不正な options で 422(zod)", async () => {
    pm.dmCampaign.findUnique.mockResolvedValue({ id: "c1", createdBy: "u1" });
    const res = await createVariant(new Request("http://x", { method: "POST", body: JSON.stringify({ label: "B", options: { ...optionFields, tone: "loud" } }) }) as never, ctxC);
    expect(res.status).toBe(422);
  });
  it("lpUrl(型ごとのLP)を指定して作成し保存する", async () => {
    pm.dmCampaign.findUnique.mockResolvedValue({ id: "c1", createdBy: "u1" });
    pm.dmVariant.create.mockResolvedValue({ id: "v2", label: "B", ...optionFields, lpUrl: "https://lp-b.example.com" });
    const res = await createVariant(new Request("http://x", { method: "POST", body: JSON.stringify({ label: "B", options: optionFields, lpUrl: "https://lp-b.example.com" }) }) as never, ctxC);
    expect(res.status).toBe(200);
    expect(pm.dmVariant.create.mock.calls[0][0].data.lpUrl).toBe("https://lp-b.example.com");
  });
  it("lpUrl 省略時は null で保存(既定LPへフォールバック)", async () => {
    pm.dmCampaign.findUnique.mockResolvedValue({ id: "c1", createdBy: "u1" });
    pm.dmVariant.create.mockResolvedValue({ id: "v2", label: "B", ...optionFields });
    await createVariant(new Request("http://x", { method: "POST", body: JSON.stringify({ label: "B", options: optionFields }) }) as never, ctxC);
    expect(pm.dmVariant.create.mock.calls[0][0].data.lpUrl).toBeNull();
  });
  it("非絶対の lpUrl(lp.example.com)は 422(郵送QRの遷移先に使えない値を弾く)", async () => {
    pm.dmCampaign.findUnique.mockResolvedValue({ id: "c1", createdBy: "u1" });
    const res = await createVariant(new Request("http://x", { method: "POST", body: JSON.stringify({ label: "B", options: optionFields, lpUrl: "lp.example.com" }) }) as never, ctxC);
    expect(res.status).toBe(422);
  });
});

describe("PATCH variant (更新)", () => {
  it("設定一式の部分更新で 200・campaignId で縛る", async () => {
    pm.dmRecipientDraft.count.mockResolvedValue(0); // 送付済みの宛先なし
    pm.dmVariant.update.mockResolvedValue({ id: "v1", label: "A2", ...optionFields });
    const res = await updateVariant(new Request("http://x", { method: "PATCH", body: JSON.stringify({ label: "A2", options: { tone: "soft" } }) }) as never, ctxV);
    expect(res.status).toBe(200);
    expect(pm.$queryRaw).toHaveBeenCalled(); // mark-sent と直列化する FOR UPDATE 行ロック(TOCTOU 防止)
    const arg = pm.dmVariant.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: "v1", campaignId: "c1" });
    expect(arg.data.tone).toBe("soft");
    expect(arg.data.label).toBe("A2");
  });

  it("options 変更時はこの型を使う未送付下書きを無効化(本文クリア→draft・要再生成)", async () => {
    pm.dmRecipientDraft.count.mockResolvedValue(0);
    pm.dmVariant.update.mockResolvedValue({ id: "v1", label: "A", ...optionFields });
    const res = await updateVariant(new Request("http://x", { method: "PATCH", body: JSON.stringify({ options: { tone: "soft" } }) }) as never, ctxV);
    expect(res.status).toBe(200);
    const inval = pm.dmRecipientDraft.updateMany.mock.calls[0][0];
    expect(inval.where).toMatchObject({ campaignId: "c1", variantId: "v1", status: { not: "sent" }, body: { not: "" } });
    expect(inval.data).toMatchObject({ body: "", status: "draft", confirmedAt: null });
  });

  it("label のみ変更は下書きを無効化しない(本文に影響しない)", async () => {
    pm.dmRecipientDraft.count.mockResolvedValue(0);
    pm.dmVariant.update.mockResolvedValue({ id: "v1", label: "A2", ...optionFields });
    const res = await updateVariant(new Request("http://x", { method: "PATCH", body: JSON.stringify({ label: "A2" }) }) as never, ctxV);
    expect(res.status).toBe(200);
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });

  it("lpUrl 変更は確定を解除するが本文は無効化しない(committedバッチの黙ったLP変更を防ぐ・Codex)", async () => {
    pm.dmRecipientDraft.count.mockResolvedValue(0);
    pm.dmVariant.update.mockResolvedValue({ id: "v1", label: "A", ...optionFields, lpUrl: "https://lp-new.example.com" });
    const res = await updateVariant(new Request("http://x", { method: "PATCH", body: JSON.stringify({ lpUrl: "https://lp-new.example.com" }) }) as never, ctxV);
    expect(res.status).toBe(200);
    expect(pm.dmVariant.update.mock.calls[0][0].data.lpUrl).toBe("https://lp-new.example.com");
    // 確定済み(印刷対象)の宛先を確定解除(status confirmed→draft, confirmedAt null)。本文は保持(消さない=再生成不要)。
    const inval = pm.dmRecipientDraft.updateMany.mock.calls[0][0];
    expect(inval.where).toMatchObject({ campaignId: "c1", variantId: "v1", status: "confirmed" });
    expect(inval.data).toMatchObject({ status: "draft", confirmedAt: null });
    expect(inval.data.body).toBeUndefined(); // 本文は消さない
  });

  it("lpUrl=null で型のLPをクリア(既定LPへ戻す)", async () => {
    pm.dmRecipientDraft.count.mockResolvedValue(0);
    pm.dmVariant.update.mockResolvedValue({ id: "v1", label: "A", ...optionFields, lpUrl: null });
    const res = await updateVariant(new Request("http://x", { method: "PATCH", body: JSON.stringify({ lpUrl: null }) }) as never, ctxV);
    expect(res.status).toBe(200);
    expect(pm.dmVariant.update.mock.calls[0][0].data.lpUrl).toBeNull();
  });

  it("送付済みの宛先がある型は lpUrl も変更不可(409・送付済みのA/B LP構成を凍結)", async () => {
    pm.dmRecipientDraft.count.mockResolvedValue(1); // 送付済みあり
    const res = await updateVariant(new Request("http://x", { method: "PATCH", body: JSON.stringify({ lpUrl: "https://lp-new.example.com" }) }) as never, ctxV);
    expect(res.status).toBe(409);
  });

  it("非絶対の lpUrl 更新は 422", async () => {
    pm.dmRecipientDraft.count.mockResolvedValue(0);
    const res = await updateVariant(new Request("http://x", { method: "PATCH", body: JSON.stringify({ lpUrl: "/relative/path" }) }) as never, ctxV);
    expect(res.status).toBe(422);
  });

  it("空の options({})は設定変更なし扱い=下書きを無効化しない(no-op を本文消去に変えない)", async () => {
    pm.dmRecipientDraft.count.mockResolvedValue(0);
    pm.dmVariant.update.mockResolvedValue({ id: "v1", label: "A", ...optionFields });
    const res = await updateVariant(new Request("http://x", { method: "PATCH", body: JSON.stringify({ options: {} }) }) as never, ctxV);
    expect(res.status).toBe(200);
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });

  it("現在値と同じ options を送る full-form 保存は無効化しない(値が変わらなければ本文を消さない)", async () => {
    pm.dmRecipientDraft.count.mockResolvedValue(0);
    pm.dmVariant.update.mockResolvedValue({ id: "v1", label: "A", ...optionFields });
    // 既存 = optionFields(beforeEach の findFirst)と同値を送信。1項目も変わらない。
    const res = await updateVariant(new Request("http://x", { method: "PATCH", body: JSON.stringify({ options: { ...optionFields } }) }) as never, ctxV);
    expect(res.status).toBe(200);
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });

  it("既存 extraInstruction=null に空文字 '' を送る label 変更は無効化しない(null↔'' は無指示で等価)", async () => {
    // beforeEach の findFirst は extraInstruction=null。フォームは label のみ変更でも
    // extraInstruction:"" を送る(編集フォームが v.extraInstruction ?? "" で初期化するため)。
    // "" と null を「変更」とみなして生成/確定済みの本文を消すとデータ損失+有料再生成になる(Codex R31 P1)。
    pm.dmRecipientDraft.count.mockResolvedValue(0);
    pm.dmVariant.update.mockResolvedValue({ id: "v1", label: "A2", ...optionFields });
    const res = await updateVariant(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ label: "A2", options: { ...optionFields, extraInstruction: "" } }) }) as never,
      ctxV,
    );
    expect(res.status).toBe(200);
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });

  it("extraInstruction は保存するが失効の契機にしない(外部AI方式・設計§2.4 R46)", async () => {
    // 旧(AI直結)はこの欄がプロンプトに逐語で入るため失効させていた。外部AI方式では
    // プロンプトに含めないので、変えても文面は変わらない=失効させると失うだけ。
    pm.dmRecipientDraft.count.mockResolvedValue(0);
    pm.dmVariant.update.mockResolvedValue({ id: "v1", label: "A", ...optionFields });
    const res = await updateVariant(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ options: { extraInstruction: "丁寧な文面で" } }) }) as never,
      ctxV,
    );
    expect(res.status).toBe(200);
    // 値は保存される。
    expect(pm.dmVariant.update.mock.calls[0][0].data.extraInstruction).toBe("丁寧な文面で");
    // 下書きの本文は消さない。
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });

  it("field_staff は担当外の未送付下書きを含む型の options 変更を拒否(403・本文消去させない)", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1", role: "field_staff" });
    pm.dmRecipientDraft.findMany.mockResolvedValue([{ propertyId: "p1" }]); // 判定はロック配下(R9)
    pm.dmRecipientDraft.count.mockResolvedValue(2); // 担当外(再割当で隠れた)の未送付下書きが存在
    const res = await updateVariant(new Request("http://x", { method: "PATCH", body: JSON.stringify({ options: { tone: "soft" } }) }) as never, ctxV);
    expect(res.status).toBe(403);
    expect(pm.dmVariant.update).not.toHaveBeenCalled();
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
    const where = pm.dmRecipientDraft.count.mock.calls[0][0].where;
    expect(where).toMatchObject({ campaignId: "c1", variantId: "v1", status: { not: "sent" } });
    // 担当外 = 可視条件の否定。未割当(assignedTo=NULL)も取りこぼさないため NOT(OR) を使う。
    expect(where.property).toEqual({ NOT: { OR: [{ createdBy: "u1" }, { assignedTo: "u1" }] } });
  });

  it("field_staff でも担当内のみの型なら options 変更できる(200)", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1", role: "field_staff" });
    pm.dmRecipientDraft.count.mockResolvedValue(0); // 担当外なし & sent なし
    pm.dmVariant.update.mockResolvedValue({ id: "v1", label: "A", ...optionFields });
    const res = await updateVariant(new Request("http://x", { method: "PATCH", body: JSON.stringify({ options: { tone: "soft" } }) }) as never, ctxV);
    expect(res.status).toBe(200);
  });

  it("field_staff の label のみ変更(本文不変)は担当外チェックをかけず許可(200)", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1", role: "field_staff" });
    pm.dmRecipientDraft.count.mockResolvedValue(0);
    pm.dmVariant.update.mockResolvedValue({ id: "v1", label: "A2", ...optionFields });
    const res = await updateVariant(new Request("http://x", { method: "PATCH", body: JSON.stringify({ label: "A2" }) }) as never, ctxV);
    expect(res.status).toBe(200);
  });

  it("field_staff は担当外の未送付下書きを含む型の lpUrl 変更を拒否(403・隠れ宛先の転送先を変えさせない・Codex)", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1", role: "field_staff" });
    // 1回目=担当外チェック(>0)→403。lpUrl 変更でも option 変更と同じ field_staff scope を適用する。
    pm.dmRecipientDraft.findMany.mockResolvedValue([{ propertyId: "p1" }]); // 判定はロック配下(R9)
    pm.dmRecipientDraft.count.mockResolvedValueOnce(1).mockResolvedValue(0);
    const res = await updateVariant(new Request("http://x", { method: "PATCH", body: JSON.stringify({ lpUrl: "https://lp-new.example.com" }) }) as never, ctxV);
    expect(res.status).toBe(403);
    expect(pm.dmVariant.update).not.toHaveBeenCalled();
    const where = pm.dmRecipientDraft.count.mock.calls[0][0].where;
    expect(where).toMatchObject({ campaignId: "c1", variantId: "v1", status: { not: "sent" } });
    expect(where.property).toEqual({ NOT: { OR: [{ createdBy: "u1" }, { assignedTo: "u1" }] } });
  });

  it("field_staff でも担当内のみの型なら lpUrl 変更できる(200)", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1", role: "field_staff" });
    pm.dmRecipientDraft.count.mockResolvedValue(0); // 担当外なし & sent なし
    pm.dmVariant.update.mockResolvedValue({ id: "v1", label: "A", ...optionFields, lpUrl: "https://lp-new.example.com" });
    const res = await updateVariant(new Request("http://x", { method: "PATCH", body: JSON.stringify({ lpUrl: "https://lp-new.example.com" }) }) as never, ctxV);
    expect(res.status).toBe(200);
    expect(pm.dmVariant.update.mock.calls[0][0].data.lpUrl).toBe("https://lp-new.example.com");
  });

  it("追加の指示だけの変更では原本も下書きも消さない(@codex #376 R3)", async () => {
    // 外部AI方式のプロンプトは追加の指示を含めない(設計§2.2)。含まれない設定の編集で
    // 原本・プロンプトの控え・全下書きの本文が消えるのは、失う一方で得るものがない。
    pm.dmRecipientDraft.count.mockResolvedValue(0);
    const res = await updateVariant(
      new Request("http://x", {
        method: "PATCH",
        body: JSON.stringify({ options: { extraInstruction: "少し柔らかく" } }),
      }) as never,
      ctxV,
    );
    expect(res.status).toBe(200);
    // 本文クリアの updateMany は呼ばれない。
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
    // 原本・プロンプトの控えを消す update も呼ばれない。
    const clearedTemplate = pm.dmVariant.update.mock.calls.some(
      (c: unknown[]) =>
        (c[0] as { data?: { bodyTemplate?: unknown } })?.data?.bodyTemplate ===
        null,
    );
    expect(clearedTemplate).toBe(false);
  });

  it("印刷デザインだけの変更では原本も下書きも消さない(@codex #376 R8)", async () => {
    // デザインは印刷時に別途あてがわれる見た目の設定で、外部AI方式のプロンプト(設計§2.2)には
    // 含まれない。含まれない設定の編集で原本・プロンプトの控え・全下書きの本文が消えるのは、
    // 失う一方で得るものがない(追加の指示と同じ型の穴)。
    pm.dmRecipientDraft.count.mockResolvedValue(0);
    pm.dmVariant.update.mockResolvedValue({ id: "v1", label: "A", ...optionFields, designTemplate: "soft" });
    const res = await updateVariant(
      new Request("http://x", {
        method: "PATCH",
        body: JSON.stringify({ options: { designTemplate: "soft" } }),
      }) as never,
      ctxV,
    );
    expect(res.status).toBe(200);
    // 値は保存される。
    expect(pm.dmVariant.update.mock.calls[0][0].data.designTemplate).toBe("soft");
    // 下書きの本文は消さない(確定解除だけは行う=刷り上がりが変わるため・R10)。
    for (const [arg] of pm.dmRecipientDraft.updateMany.mock.calls as { data: { body?: unknown } }[][]) {
      expect(arg.data.body).toBeUndefined();
    }
    // 原本・プロンプトの控えを消す update も呼ばれない。
    const clearedTemplate = pm.dmVariant.update.mock.calls.some(
      (c: unknown[]) =>
        (c[0] as { data?: { bodyTemplate?: unknown } })?.data?.bodyTemplate === null,
    );
    expect(clearedTemplate).toBe(false);
  });

  it("field_staff は担当外の未送付下書きを含む型のデザイン変更を拒否(403・隠れ宛先の印刷結果を変えさせない)", async () => {
    // 本文は消さない変更でも、デザインは**この型の全宛先**(担当外で見えない宛先を含む)の
    // 印刷結果を変える → lpUrl と同じ scope を要求する。
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1", role: "field_staff" });
    pm.dmRecipientDraft.findMany.mockResolvedValue([{ propertyId: "p1" }]); // 判定はロック配下(R9)
    pm.dmRecipientDraft.count.mockResolvedValueOnce(1).mockResolvedValue(0);
    const res = await updateVariant(
      new Request("http://x", {
        method: "PATCH",
        body: JSON.stringify({ options: { designTemplate: "soft" } }),
      }) as never,
      ctxV,
    );
    expect(res.status).toBe(403);
    expect(pm.dmVariant.update).not.toHaveBeenCalled();
    const where = pm.dmRecipientDraft.count.mock.calls[0][0].where;
    expect(where).toMatchObject({ campaignId: "c1", variantId: "v1", status: { not: "sent" } });
    expect(where.property).toEqual({ NOT: { OR: [{ createdBy: "u1" }, { assignedTo: "u1" }] } });
  });

  // 件数の問い合わせを内容で振り分ける(1つの mockResolvedValue だと、確定済みと送付済みを
  // 別々に置けず「確定はあるが送付はまだ」の状態を作れない=R10 の場面が作れない)。
  const counts = ({ scope = 0, settled = 0, sent = 0 }: { scope?: number; settled?: number; sent?: number }) =>
    pm.dmRecipientDraft.count.mockImplementation(
      async (args: { where?: { property?: unknown; status?: unknown } }) => {
        const w = args?.where ?? {};
        if (w.property !== undefined) return scope;       // 担当外の数え直し
        if (w.status === "sent") return sent;             // 送付済み
        return settled;                                   // 確定済み+送付済み
      },
    );

  it("確定済み(未送付)があってもLPだけの変更はできる(確定は解除される・@codex #376 R10)", async () => {
    // ⚠凍結は**文面(プロンプトに載る設定)**を守るためのもの(設計§2.4)。LPは文面ではないので、
    //   まだ1通も送っていないなら直せる。直せないと、印刷待ちの段階でLPの誤りに気づいても
    //   手の打ちようがない(確定を戻す一括の導線は無い)。
    counts({ settled: 1, sent: 0 });
    pm.dmVariant.update.mockResolvedValue({ id: "v1", label: "A", ...optionFields, lpUrl: "https://lp-new.example.com" });
    const res = await updateVariant(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ lpUrl: "https://lp-new.example.com" }) }) as never,
      ctxV,
    );
    expect(res.status).toBe(200);
    const inval = pm.dmRecipientDraft.updateMany.mock.calls[0][0];
    expect(inval.where).toMatchObject({ status: "confirmed" }); // 確定解除=再確認を促す
    expect(inval.data.body).toBeUndefined();                    // 本文は消さない
  });

  it("確定済み(未送付)があってもデザインだけの変更はできる(確定は解除される)", async () => {
    counts({ settled: 1, sent: 0 });
    pm.dmVariant.update.mockResolvedValue({ id: "v1", label: "A", ...optionFields, designTemplate: "soft" });
    const res = await updateVariant(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ options: { designTemplate: "soft" } }) }) as never,
      ctxV,
    );
    expect(res.status).toBe(200);
    const inval = pm.dmRecipientDraft.updateMany.mock.calls[0][0];
    expect(inval.where).toMatchObject({ status: "confirmed" });
    expect(inval.data.body).toBeUndefined();
  });

  it("確定を解除する前に凍結印を立てる(証拠を消してから消し得る状態にしない・@codex #376 R11)", async () => {
    // ⚠印がまだ無く確定だけがある型(照合スクリプト前の状態)で LP/デザインを変えると、
    //   確定解除で**最後の証拠が消え**、そのあと文面を差し替え放題になる。
    //   解除の前に、同じ処理の中で印を立てる(設計§2.4「証拠を消す前に固定する」)。
    counts({ settled: 1, sent: 0 });
    pm.dmVariant.update.mockResolvedValue({ id: "v1", label: "A", ...optionFields, lpUrl: "https://lp-new.example.com" });
    const res = await updateVariant(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ lpUrl: "https://lp-new.example.com" }) }) as never,
      ctxV,
    );
    expect(res.status).toBe(200);
    const freezeIdx = (pm.dmVariant.updateMany.mock.calls as { data?: { templateFrozenAt?: unknown } }[][]).findIndex(
      (c) => c[0]?.data?.templateFrozenAt != null,
    );
    expect(freezeIdx).toBeGreaterThan(-1);
    expect(pm.dmVariant.updateMany.mock.calls[freezeIdx][0].where).toMatchObject({ templateFrozenAt: null });
    // 確定解除より**前**に立てる。
    expect(pm.dmVariant.updateMany.mock.invocationCallOrder[freezeIdx]).toBeLessThan(
      pm.dmRecipientDraft.updateMany.mock.invocationCallOrder[0],
    );
  });

  it("確定が1件も無ければ凍結印は立てない(見た目を変えただけの型の文面を縛らない)", async () => {
    counts({ settled: 0, sent: 0 });
    pm.dmVariant.update.mockResolvedValue({ id: "v1", label: "A", ...optionFields, designTemplate: "soft" });
    const res = await updateVariant(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ options: { designTemplate: "soft" } }) }) as never,
      ctxV,
    );
    expect(res.status).toBe(200);
    const froze = (pm.dmVariant.updateMany.mock.calls as { data?: { templateFrozenAt?: unknown } }[][]).some(
      (c) => c[0]?.data?.templateFrozenAt != null,
    );
    expect(froze).toBe(false);
  });

  it("確定済み(未送付)があると文面の設定は変更できない(409・凍結が守るのは文面)", async () => {
    counts({ settled: 1, sent: 0 });
    const res = await updateVariant(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ options: { tone: "soft" } }) }) as never,
      ctxV,
    );
    expect(res.status).toBe(409);
    expect(pm.dmVariant.update).not.toHaveBeenCalled();
  });

  it("送付済みがあればデザインもLPも変更できない(送った構成は動かさない)", async () => {
    counts({ settled: 1, sent: 1 });
    const design = await updateVariant(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ options: { designTemplate: "soft" } }) }) as never,
      ctxV,
    );
    expect(design.status).toBe(409);
    const lp = await updateVariant(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ lpUrl: "https://lp-new.example.com" }) }) as never,
      ctxV,
    );
    expect(lp.status).toBe(409);
    expect(pm.dmVariant.update).not.toHaveBeenCalled();
  });

  it("field_staff の担当範囲は、物件行をロックしてから見直す(@codex #376 R9)", async () => {
    // ⚠ロックの外で数えると、数えた直後〜commit の間に担当が変わった宛先の
    //   印刷結果まで変えてしまう(貼り付け/適用の経路と同じ形にそろえる)。
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1", role: "field_staff" });
    pm.dmRecipientDraft.findMany.mockResolvedValue([{ propertyId: "p1" }, { propertyId: "p2" }]);
    pm.dmRecipientDraft.count.mockResolvedValue(0);
    pm.dmVariant.update.mockResolvedValue({ id: "v1", label: "A", ...optionFields });
    const res = await updateVariant(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ options: { tone: "soft" } }) }) as never,
      ctxV,
    );
    expect(res.status).toBe(200);
    // 物件行の FOR UPDATE が発行されている。
    const lockIdx = (pm.$queryRaw.mock.calls as unknown[][]).findIndex((c) =>
      (c[0] as string[]).join("?").includes("FROM properties"),
    );
    expect(lockIdx).toBeGreaterThan(-1);
    // 担当外の数え直しは、そのロックの**あと**。
    const scopeIdx = (pm.dmRecipientDraft.count.mock.calls as { where?: { property?: unknown } }[][]).findIndex(
      (c) => c[0]?.where?.property !== undefined,
    );
    expect(scopeIdx).toBeGreaterThan(-1);
    expect(pm.$queryRaw.mock.invocationCallOrder[lockIdx]).toBeLessThan(
      pm.dmRecipientDraft.count.mock.invocationCallOrder[scopeIdx],
    );
    // 型行のロックが物件行より先(設計§2.3: variant → 物件親行 → 子行)。
    const variantLockIdx = (pm.$queryRaw.mock.calls as unknown[][]).findIndex((c) =>
      (c[0] as string[]).join("?").includes("FROM dm_variants"),
    );
    expect(variantLockIdx).toBeGreaterThan(-1);
    expect(pm.$queryRaw.mock.invocationCallOrder[variantLockIdx]).toBeLessThan(
      pm.$queryRaw.mock.invocationCallOrder[lockIdx],
    );
  });

  it("確定済み/送付済みの宛先がある型は設定変更を拒否(409 VARIANT_LOCKED)・更新しない", async () => {
    // PR-D2: 送付済みだけでなく**確定済み**でも止める(文面と A/B 構成の出所を守る・設計§2.4)。
    pm.dmRecipientDraft.count.mockResolvedValue(2);
    const res = await updateVariant(new Request("http://x", { method: "PATCH", body: JSON.stringify({ options: { tone: "soft" } }) }) as never, ctxV);
    expect(res.status).toBe(409);
    expect(pm.dmVariant.update).not.toHaveBeenCalled();
    const countArg = pm.dmRecipientDraft.count.mock.calls[0][0];
    expect(countArg.where).toMatchObject({ campaignId: "c1", variantId: "v1" });
    expect(countArg.where.status).toEqual({ in: ["confirmed", "sent"] });
  });

  it("更新中に別requestがこの型の宛先をsent化したら 409(TOCTOU・トランザクション前後でsentチェック)", async () => {
    // sentBefore=0(通過)→ update → sentAfter=2(競合検出)→ ロールバックして 409。
    pm.dmRecipientDraft.count.mockResolvedValueOnce(0).mockResolvedValueOnce(2);
    pm.dmVariant.update.mockResolvedValue({ id: "v1", label: "A", ...optionFields });
    const res = await updateVariant(new Request("http://x", { method: "PATCH", body: JSON.stringify({ options: { tone: "soft" } }) }) as never, ctxV);
    expect(res.status).toBe(409);
    expect(pm.dmRecipientDraft.count).toHaveBeenCalledTimes(2);
  });
  it("権限不足で 403", async () => {
    grant("property");
    const res = await updateVariant(new Request("http://x", { method: "PATCH", body: JSON.stringify({ label: "x" }) }) as never, ctxV);
    expect(res.status).toBe(403);
    expect(pm.dmVariant.update).not.toHaveBeenCalled();
  });
  it("存在しない/別campaignの型IDは 404(P2025→500 でなく)・更新しない", async () => {
    pm.dmVariant.findFirst.mockResolvedValue(null);
    const res = await updateVariant(new Request("http://x", { method: "PATCH", body: JSON.stringify({ label: "x" }) }) as never, ctxV);
    expect(res.status).toBe(404);
    expect(pm.dmVariant.update).not.toHaveBeenCalled();
  });
});

describe("DELETE variant (削除ガード)", () => {
  // ⚠vi.clearAllMocks は mockResolvedValue の実装を消さない。PATCH のテストが入れた
  //   count=2 が残ると、削除の凍結判定が誤って発火する(実際に踏んだ)。明示的に戻す。
  it("割当済みドラフトが無ければ削除し 200(下書きを持たない場合のみのアトミック条件付き削除)", async () => {
    pm.dmRecipientDraft.count.mockResolvedValue(0);
    pm.dmVariant.deleteMany.mockResolvedValue({ count: 1 });
    const res = await deleteVariant(new Request("http://x", { method: "DELETE" }) as never, ctxV);
    expect(res.status).toBe(200);
    // count→delete の TOCTOU を避けるため recipients:{none:{}} 条件のアトミック deleteMany を使う。
    expect(pm.dmVariant.deleteMany).toHaveBeenCalledWith({ where: { id: "v1", campaignId: "c1", recipients: { none: {} } } });
  });
  it("割当済みドラフトがあれば 409・削除しない(count=0)", async () => {
    pm.dmRecipientDraft.count.mockResolvedValue(0);
    pm.dmVariant.deleteMany.mockResolvedValue({ count: 0 }); // 下書きが存在=条件不一致で 0 行
    const res = await deleteVariant(new Request("http://x", { method: "DELETE" }) as never, ctxV);
    expect(res.status).toBe(409);
  });
  it("権限不足で 403", async () => {
    grant("property");
    const res = await deleteVariant(new Request("http://x", { method: "DELETE" }) as never, ctxV);
    expect(res.status).toBe(403);
    expect(pm.dmVariant.deleteMany).not.toHaveBeenCalled();
  });
  it("存在しない型IDの削除は 404(P2025→500 でなく)・削除しない", async () => {
    pm.dmVariant.findFirst.mockResolvedValue(null);
    const res = await deleteVariant(new Request("http://x", { method: "DELETE" }) as never, ctxV);
    expect(res.status).toBe(404);
    expect(pm.dmVariant.deleteMany).not.toHaveBeenCalled();
  });
});

describe("自由記述フィールドの最大長(有料AI fan-out 前のガード)", () => {
  const base = { name: "x", options: { designTemplate: "formal", tone: "formal", length: "medium", appeal: "price", strength: "low" } } as const;
  const reject = (opts: Record<string, unknown>) =>
    saleDmCampaignBodySchema.safeParse({ ...base, options: { ...base.options, ...opts } }).success;
  it("senderName>100 / senderContact>200 / extraInstruction>1000 は弾く", () => {
    expect(reject({ senderName: "あ".repeat(101) })).toBe(false);
    expect(reject({ senderContact: "あ".repeat(201) })).toBe(false);
    expect(reject({ extraInstruction: "あ".repeat(1001) })).toBe(false);
  });
  it("キャンペーン名は >100 で弾く・<=100 は通る", () => {
    expect(saleDmCampaignBodySchema.safeParse({ ...base, name: "あ".repeat(101) }).success).toBe(false);
    expect(saleDmCampaignBodySchema.safeParse({ ...base, name: "あ".repeat(100) }).success).toBe(true);
  });
  it("上限内は通る", () => {
    expect(reject({ senderName: "差出人", senderContact: "連絡先", extraInstruction: "あ".repeat(1000) })).toBe(true);
  });
});
