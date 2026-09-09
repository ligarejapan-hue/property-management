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
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    dmRecipientDraft: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    dmVariant: { findFirst: vi.fn(), updateMany: vi.fn(async () => ({ count: 0 })) },
    // 確定を戻す/型を移す前に凍結印を立てる(PR-D2 設計§2.4)。tx=同db委譲。
    // 凍結印(DM型/LP型)→割当の読み直し→解除、までを同じ tx で行う(@codex R3 P2)。
    dmLpVariant: { updateMany: vi.fn(async () => ({ count: 0 })) },
    $queryRaw: vi.fn(async () => []),
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { default: db };
});

import { describe, it, expect, beforeEach } from "vitest";
import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { PATCH as patchDraft } from "../../app/api/properties/sale-dm/drafts/[id]/route";
import { Prisma } from "@/generated/prisma";

const pm = prismaMock as never as {
  dmRecipientDraft: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  dmVariant: { findFirst: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  dmLpVariant: { updateMany: ReturnType<typeof vi.fn> };
  $queryRaw: ReturnType<typeof vi.fn>;
};
const ALL = ["property", "csv_export", "csv_export_personal", "owner"];
const grant = (...keys: string[]) =>
  (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue([...keys.map((k) => ({ resource: k, action: "read", granted: true })), { resource: "property", action: "write", granted: true }]);
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

  it("凍結印を立てる直前に型の割当が変わっていたら 409 VARIANT_CHANGED・解除しない", async () => {
    // 先読み(L1)と、型をロックしてからの読み直し(L2)が食い違う=途中で /assign が動いた。
    // そのまま進めると印は古い L1 にしか立たず、解除で L2 の「確定があった」証拠が消える(@codex R3 P2)。
    // ⚠`Once` の並びで組むと、実装が読み直しをやめただけで余りが次のテストへ漏れる。
    //   先読み(campaign を select する)と tx 内の読み直しを select の形で見分ける。
    pm.dmRecipientDraft.findUnique.mockImplementation(async (args: { select?: Record<string, unknown> }) =>
      args?.select?.campaign
        ? { id: "r1", campaignId: "c1", status: "confirmed", variantId: "v1", lpVariantId: "L1", campaign: { createdBy: "u1" } }
        : { variantId: "v1", lpVariantId: "L2", status: "confirmed" },
    );
    const res = await patchDraft(patch({ body: "編集後" }) as never, ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("VARIANT_CHANGED");
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
    // 割当が食い違ったまま凍結印を立てない(古い型だけ凍結して終わらせない)。
    expect(pm.dmVariant.updateMany).not.toHaveBeenCalled();
    expect(pm.dmLpVariant.updateMany).not.toHaveBeenCalled();
  });

  it("確定の解除は凍結印・読み直し・解除を同じ tx で行う(印の後に updateMany)", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue({ id: "r1", campaignId: "c1", status: "confirmed", variantId: "v1", lpVariantId: "L1", campaign: { createdBy: "u1" } });
    const res = await patchDraft(patch({ body: "編集後" }) as never, ctx);
    expect(res.status).toBe(200);
    expect(pm.dmVariant.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["v1"] }, templateFrozenAt: null }, data: { templateFrozenAt: expect.any(Date) } });
    expect(pm.dmLpVariant.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["L1"] }, templateFrozenAt: null }, data: { templateFrozenAt: expect.any(Date) } });
    expect(pm.dmRecipientDraft.updateMany.mock.calls[0][0].where).toEqual({ id: "r1", status: { not: "sent" } });
  });

  it("型を移すときは移動元と移動先の両方を1文で id 順に掴む(逆向きの付け替えと互い違いにしない)", async () => {
    // V1→V2 と V2→V1 が同時に走ると、片方ずつ掴む書き方では移動先で待たされて両者が止まる
    // (updateMany が参照先の型行へ KEY SHARE を後から取るため)。取得順を id 順にそろえる。
    pm.dmRecipientDraft.findUnique.mockResolvedValue({ id: "r1", campaignId: "c1", status: "confirmed", variantId: "v-old", campaign: { createdBy: "u1" } });
    pm.dmVariant.findFirst.mockResolvedValue({ id: "vB" });
    const res = await patchDraft(patch({ variantId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11" }) as never, ctx);
    expect(res.status).toBe(200);
    // $queryRaw はタグ付きテンプレート: 第2引数が ${} の値(=ロックする id の配列)。
    const lockCall = pm.$queryRaw.mock.calls.find((c: unknown[]) =>
      (Array.isArray(c[0]) ? (c[0] as string[]).join("?") : String(c[0])).includes("FROM dm_variants"),
    );
    expect(lockCall?.[1]).toEqual(["a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", "v-old"]);
  });

  it("型を移さないときは今の型だけを掴む(1件のまま)", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue({ id: "r1", campaignId: "c1", status: "confirmed", variantId: "v1", campaign: { createdBy: "u1" } });
    const res = await patchDraft(patch({ body: "編集後" }) as never, ctx);
    expect(res.status).toBe(200);
    const lockCall = pm.$queryRaw.mock.calls.find((c: unknown[]) =>
      (Array.isArray(c[0]) ? (c[0] as string[]).join("?") : String(c[0])).includes("FROM dm_variants"),
    );
    expect(lockCall?.[1]).toEqual(["v1"]);
  });

  it("確定解除の経路でも、並行して sent になっていれば(count=0)409 ALREADY_SENT", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue({ id: "r1", campaignId: "c1", status: "confirmed", variantId: "v1", campaign: { createdBy: "u1" } });
    pm.dmRecipientDraft.updateMany.mockResolvedValue({ count: 0 });
    const res = await patchDraft(patch({ body: "編集後" }) as never, ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("ALREADY_SENT");
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
