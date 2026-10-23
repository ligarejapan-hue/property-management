/**
 * PATCH /api/properties/[id]/attachments/[attachmentId] — 書類の種類を人が決め直す。
 * 権限・404・謄本 422・知らない種類 422・manual になる・名前の作り直し・監査に名前を出さない。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  return { NextRequest: MockNextRequest };
});
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number; code: string;
    constructor(status: number, message: string, code = "ERROR") { super(message); this.status = status; this.code = code; }
  }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(),
    getUserPermissions: vi.fn(),
    handleApiError: vi.fn((e: { status?: number; message?: string; code?: string; name?: string }) =>
      Response.json({ error: { message: e?.message, code: e?.code ?? e?.name } }, { status: e?.status ?? (e?.name === "ZodError" ? 422 : 500) })),
    apiResponse: vi.fn((data: unknown, status = 200) => Response.json(data, { status })),
  };
});
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
vi.mock("@/lib/url-normalize", () => ({ normalizeFileUrlsInRecord: (r: unknown) => r }));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    attachment: { findUnique: vi.fn(), findMany: vi.fn(async () => []), update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "a", ...data })) },
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  db.$queryRaw = vi.fn(async () => [{ id: "p" }]);
  return { default: db };
});

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { PATCH } from "../route";

const pm = prisma as unknown as { attachment: { findUnique: Mock; findMany: Mock; update: Mock }; $queryRaw: Mock };
const PROP = "11111111-1111-4111-8111-111111111111";
const ATT = "22222222-2222-4222-8222-222222222222";
const NOW = new Date(2026, 9, 23, 10, 0, 0);

function ctx() { return { params: Promise.resolve({ id: PROP, attachmentId: ATT }) }; }
function req(body: unknown) {
  const text = JSON.stringify(body);
  return new Request("http://t/", { method: "PATCH", body: text, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) } });
}
function att(over: Record<string, unknown> = {}) {
  return {
    id: ATT, targetType: "property", targetId: PROP, isDeleted: false, type: "general",
    fileName: "【完成版】売買契約書.pdf", docTitle: "売買契約書_ハマイハイライズ305_20260901.pdf", docKind: "sales_contract", createdAt: NOW,
    property: { createdBy: "u1", assignedTo: null, buildingName: "ハマイハイライズ", roomNo: "305", address: "東京都…" },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as unknown as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as unknown as Mock).mockResolvedValue([{ resource: "property", action: "write", granted: true }]);
  pm.attachment.findUnique.mockResolvedValue(att());
  pm.attachment.findMany.mockResolvedValue([]);
});

describe("PATCH 添付の種類", () => {
  it("種類を変えると段階と名前が作り直され、確からしさは manual。日付は今の名前を引き継ぐ", async () => {
    const res = await PATCH(req({ docKind: "disclosure" }) as never, ctx() as never);
    expect(res.status).toBe(200);
    const data = pm.attachment.update.mock.calls[0][0].data;
    expect(data).toEqual({
      docStage: "contract",
      docKind: "disclosure",
      docTitle: "重要事項説明書_ハマイハイライズ305_20260901.pdf",
      docConfidence: "manual",
    });
    // 親の物件行をロックしてから更新する
    expect(pm.$queryRaw).toHaveBeenCalled();
  });

  it("同じ名前がほかにあれば連番(自分の名前は除く)", async () => {
    pm.attachment.findMany.mockResolvedValueOnce([{ docTitle: "重要事項説明書_ハマイハイライズ305_20260901.pdf" }]);
    await PATCH(req({ docKind: "disclosure" }) as never, ctx() as never);
    expect(pm.attachment.update.mock.calls[0][0].data.docTitle).toBe("重要事項説明書_ハマイハイライズ305_20260901_2.pdf");
    const where = pm.attachment.findMany.mock.calls[0][0].where;
    expect(where.id).toEqual({ not: ATT });
  });

  it("null は「その他」=4列とも null", async () => {
    const res = await PATCH(req({ docKind: null }) as never, ctx() as never);
    expect(res.status).toBe(200);
    expect(pm.attachment.update.mock.calls[0][0].data).toEqual({ docStage: null, docKind: null, docTitle: null, docConfidence: null });
  });

  it("知らない種類 → 422・更新しない", async () => {
    const res = await PATCH(req({ docKind: "nope" }) as never, ctx() as never);
    expect(res.status).toBe(422);
    expect(pm.attachment.update).not.toHaveBeenCalled();
  });

  it("謄本(registry) → 422・更新しない", async () => {
    pm.attachment.findUnique.mockResolvedValueOnce(att({ type: "registry" }));
    const res = await PATCH(req({ docKind: "sales_contract" }) as never, ctx() as never);
    expect(res.status).toBe(422);
    expect(pm.attachment.update).not.toHaveBeenCalled();
  });

  it("別の物件の添付・削除済み → 404", async () => {
    pm.attachment.findUnique.mockResolvedValueOnce(att({ targetId: "33333333-3333-4333-8333-333333333333" }));
    expect((await PATCH(req({ docKind: "disclosure" }) as never, ctx() as never)).status).toBe(404);
    pm.attachment.findUnique.mockResolvedValueOnce(att({ isDeleted: true }));
    expect((await PATCH(req({ docKind: "disclosure" }) as never, ctx() as never)).status).toBe(404);
  });

  it("field_staff・担当外 → 403", async () => {
    (getApiSession as unknown as Mock).mockResolvedValue({ id: "other", role: "field_staff" });
    const res = await PATCH(req({ docKind: "disclosure" }) as never, ctx() as never);
    expect(res.status).toBe(403);
    expect(pm.attachment.update).not.toHaveBeenCalled();
  });

  it("読んだあとロックまでに担当が外れた field_staff → ロック時の再確認で 403・更新しない(@codex P2)", async () => {
    (getApiSession as unknown as Mock).mockResolvedValue({ id: "u1", role: "field_staff" });
    // 最初の読みでは担当(createdBy=u1)だが、ロックを取る SELECT は範囲外で 0 行を返す
    pm.$queryRaw.mockResolvedValueOnce([]);
    const res = await PATCH(req({ docKind: "disclosure" }) as never, ctx() as never);
    expect(res.status).toBe(403);
    expect(pm.attachment.update).not.toHaveBeenCalled();
  });

  it("property:write が無い → 403", async () => {
    (getUserPermissions as unknown as Mock).mockResolvedValue([]);
    expect((await PATCH(req({ docKind: "disclosure" }) as never, ctx() as never)).status).toBe(403);
  });

  it("監査には物件IDと種類だけ(ファイル名を出さない)", async () => {
    await PATCH(req({ docKind: "disclosure" }) as never, ctx() as never);
    const call = writeAuditLog.mock.calls[0][0];
    expect(call.action).toBe("update");
    expect(call.targetTable).toBe("attachments");
    expect(call.detail).toEqual({ propertyId: PROP, docKind: "disclosure" });
    expect(JSON.stringify(call)).not.toContain("売買契約書");
  });
});
