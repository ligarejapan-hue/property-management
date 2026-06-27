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
    // Resolution: mirror real handleApiError — ZodError (has issues array) → 422, MockApiError → status, else 500
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
vi.mock("@/lib/prisma", () => ({
  default: {
    dmRecipientDraft: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    dmVariant: { findFirst: vi.fn() },
  },
}));

import { describe, it, expect, beforeEach } from "vitest";
import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { PATCH as patchDraft } from "../../app/api/properties/sale-dm/drafts/[id]/route";
import { Prisma } from "@/generated/prisma";

const pm = prismaMock as never as {
  dmRecipientDraft: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  dmVariant: { findFirst: ReturnType<typeof vi.fn> };
};
const ALL = ["property", "csv_export", "csv_export_personal", "owner"];
const grant = (...keys: string[]) =>
  (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(keys.map((k) => ({ resource: k, action: "read", granted: true })));
const ctx = { params: Promise.resolve({ id: "r1" }) };
const patch = (b: unknown) => new Request("http://x", { method: "PATCH", body: JSON.stringify(b) });

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1" });
  (getOwnerDisplayConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
  grant(...ALL);
  pm.dmRecipientDraft.findUnique.mockResolvedValue({ id: "r1", campaignId: "c1", status: "draft", campaign: { createdBy: "u1" } });
  pm.dmRecipientDraft.update.mockResolvedValue({ id: "r1" });
  pm.dmRecipientDraft.updateMany.mockResolvedValue({ count: 1 });
});

describe("PATCH draft (拡張)", () => {
  it("body 編集で 200・確定を解除(本文変更→draft へ・confirmedAt 消去=再承認必須)", async () => {
    const res = await patchDraft(patch({ body: "編集後" }) as never, ctx);
    expect(res.status).toBe(200);
    const data = pm.dmRecipientDraft.updateMany.mock.calls[0][0].data;
    expect(data.body).toBe("編集後");
    // 確定済みの本文を編集したら確定解除(承認した文面と印刷/送付する文面を一致させる)。
    expect(data.status).toBe("draft");
    expect(data.confirmedAt).toBeNull();
  });

  it("override 単独編集(本文不変)は確定を解除しない(印刷/送付の承認を保持)", async () => {
    const res = await patchDraft(patch({ override: { tone: "soft" } }) as never, ctx);
    expect(res.status).toBe(200);
    const data = pm.dmRecipientDraft.updateMany.mock.calls[0][0].data;
    expect(data.overrideJson).toEqual({ tone: "soft" });
    expect(data.status).toBeUndefined();
    expect(data.confirmedAt).toBeUndefined();
  });

  it("override: null で上書きを消去できる(DB NULL=Prisma.DbNull)", async () => {
    const res = await patchDraft(patch({ override: null }) as never, ctx);
    expect(res.status).toBe(200);
    // nullable Json の消去は Prisma.DbNull で行う(素の null は実行時に拒否される)。
    expect(pm.dmRecipientDraft.updateMany.mock.calls[0][0].data.overrideJson).toBe(Prisma.DbNull);
  });

  it("variantId 付け替え(本文未指定)は当該 campaign の型のみ許可+本文クリア=要再生成", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue({ id: "r1", campaignId: "c1", status: "confirmed", variantId: "v-old", campaign: { createdBy: "u1" } });
    pm.dmVariant.findFirst.mockResolvedValue({ id: "vB" });
    const res = await patchDraft(patch({ variantId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11" }) as never, ctx);
    expect(res.status).toBe(200);
    expect(pm.dmVariant.findFirst).toHaveBeenCalled();
    const data = pm.dmRecipientDraft.updateMany.mock.calls[0][0].data;
    expect(data.variantId).toBe("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11");
    // 旧 variant の作風のまま新ラベルで送る A/B 不一致を防ぐため本文をクリア・draft へ戻す。
    expect(data.body).toBe("");
    expect(data.status).toBe("draft");
    expect(data.confirmedAt).toBeNull();
  });

  it("variantId 付け替えでも本文を同時指定すればその本文を保持(クリアしない)", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue({ id: "r1", campaignId: "c1", status: "draft", variantId: "v-old", campaign: { createdBy: "u1" } });
    pm.dmVariant.findFirst.mockResolvedValue({ id: "vB" });
    const res = await patchDraft(patch({ variantId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", body: "新本文" }) as never, ctx);
    expect(res.status).toBe(200);
    expect(pm.dmRecipientDraft.updateMany.mock.calls[0][0].data.body).toBe("新本文");
  });

  it("同一 variantId への付け替え(実質変更なし)は本文をクリアしない", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue({ id: "r1", campaignId: "c1", status: "confirmed", variantId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", campaign: { createdBy: "u1" } });
    pm.dmVariant.findFirst.mockResolvedValue({ id: "vB" });
    const res = await patchDraft(patch({ variantId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11" }) as never, ctx);
    expect(res.status).toBe(200);
    const data = pm.dmRecipientDraft.updateMany.mock.calls[0][0].data;
    expect(data.body).toBeUndefined();
    expect(data.status).toBeUndefined();
  });

  it("他キャンペーンの variantId は 404/400(更新しない)", async () => {
    pm.dmVariant.findFirst.mockResolvedValue(null);
    const res = await patchDraft(patch({ variantId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11" }) as never, ctx);
    expect([400, 404]).toContain(res.status);
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });

  it("空 body(更新フィールドなし)で 422", async () => {
    const res = await patchDraft(patch({}) as never, ctx);
    expect(res.status).toBe(422);
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });

  it("存在しない draft で 404", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue(null);
    const res = await patchDraft(patch({ body: "x" }) as never, ctx);
    expect(res.status).toBe(404);
  });

  it("他人のキャンペーン配下の draft は 404・更新しない(横断アクセス防止)", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue({ id: "r1", campaignId: "c1", status: "draft", campaign: { createdBy: "other-user" } });
    const res = await patchDraft(patch({ body: "x" }) as never, ctx);
    expect(res.status).toBe(404);
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });

  it("送付済み(sent)の draft の編集は 409・更新しない", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue({ id: "r1", campaignId: "c1", status: "sent", campaign: { createdBy: "u1" } });
    const res = await patchDraft(patch({ body: "x" }) as never, ctx);
    expect(res.status).toBe(409);
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });

  it("field_staff は担当外物件の宛先(再割当で隠れた)を編集できない・403・更新しない(record scope)", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1", role: "field_staff" });
    pm.dmRecipientDraft.findUnique.mockResolvedValue({ id: "r1", campaignId: "c1", status: "draft", variantId: "v1", campaign: { createdBy: "u1" }, property: { createdBy: "other", assignedTo: "other" } });
    const res = await patchDraft(patch({ body: "x" }) as never, ctx);
    expect(res.status).toBe(403);
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });

  it("field_staff でも作成 or 担当の物件の宛先なら編集できる(200)", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1", role: "field_staff" });
    pm.dmRecipientDraft.findUnique.mockResolvedValue({ id: "r1", campaignId: "c1", status: "draft", variantId: "v1", campaign: { createdBy: "u1" }, property: { createdBy: "other", assignedTo: "u1" } });
    const res = await patchDraft(patch({ body: "x" }) as never, ctx);
    expect(res.status).toBe(200);
    expect(pm.dmRecipientDraft.updateMany.mock.calls[0][0].data.body).toBe("x");
  });
});
