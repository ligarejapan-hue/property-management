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
    dmVariant: { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), findFirst: vi.fn() },
    dmRecipientDraft: { count: vi.fn(), updateMany: vi.fn() },
  };
  // $transaction はコールバックに同じ db を tx として渡す(tx.* === pm.* なので既存アサーションがそのまま効く)。
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
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
  dmVariant: { findMany: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  dmRecipientDraft: { count: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
};
const ALL = ["property", "csv_export", "csv_export_personal", "owner"];
const grant = (...keys: string[]) =>
  (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(
    keys.map((k) => ({ resource: k, action: "read", granted: true })),
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
});

describe("PATCH variant (更新)", () => {
  it("設定一式の部分更新で 200・campaignId で縛る", async () => {
    pm.dmRecipientDraft.count.mockResolvedValue(0); // 送付済みの宛先なし
    pm.dmVariant.update.mockResolvedValue({ id: "v1", label: "A2", ...optionFields });
    const res = await updateVariant(new Request("http://x", { method: "PATCH", body: JSON.stringify({ label: "A2", options: { tone: "soft" } }) }) as never, ctxV);
    expect(res.status).toBe(200);
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

  it("extraInstruction を null から実テキストへ変えると無効化する(実変更は確実に検出)", async () => {
    pm.dmRecipientDraft.count.mockResolvedValue(0);
    pm.dmVariant.update.mockResolvedValue({ id: "v1", label: "A", ...optionFields });
    const res = await updateVariant(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ options: { extraInstruction: "丁寧な文面で" } }) }) as never,
      ctxV,
    );
    expect(res.status).toBe(200);
    expect(pm.dmRecipientDraft.updateMany).toHaveBeenCalled();
  });

  it("field_staff は担当外の未送付下書きを含む型の options 変更を拒否(403・本文消去させない)", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1", role: "field_staff" });
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

  it("送付済みの宛先がある型は設定変更を拒否(409 VARIANT_LOCKED)・更新しない", async () => {
    pm.dmRecipientDraft.count.mockResolvedValue(2); // この型を使った送付済みドラフトが存在
    const res = await updateVariant(new Request("http://x", { method: "PATCH", body: JSON.stringify({ options: { tone: "soft" } }) }) as never, ctxV);
    expect(res.status).toBe(409);
    expect(pm.dmVariant.update).not.toHaveBeenCalled();
    const countArg = pm.dmRecipientDraft.count.mock.calls[0][0];
    expect(countArg.where).toMatchObject({ campaignId: "c1", variantId: "v1", status: "sent" });
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
  it("割当済みドラフトが無ければ削除し 200(下書きを持たない場合のみのアトミック条件付き削除)", async () => {
    pm.dmVariant.deleteMany.mockResolvedValue({ count: 1 });
    const res = await deleteVariant(new Request("http://x", { method: "DELETE" }) as never, ctxV);
    expect(res.status).toBe(200);
    // count→delete の TOCTOU を避けるため recipients:{none:{}} 条件のアトミック deleteMany を使う。
    expect(pm.dmVariant.deleteMany).toHaveBeenCalledWith({ where: { id: "v1", campaignId: "c1", recipients: { none: {} } } });
  });
  it("割当済みドラフトがあれば 409・削除しない(count=0)", async () => {
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
