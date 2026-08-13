import { vi } from "vitest";
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
    getOwnerDisplayConfig: vi.fn(),
    parseJsonBody: vi.fn(async (r: Request) => {
      const t = await r.text();
      return t ? JSON.parse(t) : {};
    }),
    handleApiError: vi.fn((e: unknown) =>
      e instanceof MockApiError
        ? Response.json(
            { error: { message: e.message, code: e.code } },
            { status: e.status },
          )
        : Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 }),
    ),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    dmRecipientDraft: { findUnique: vi.fn(), updateMany: vi.fn() },
    dmVariant: { findFirst: vi.fn() },
  };
  return { default: db };
});

import { describe, it, expect, beforeEach } from "vitest";
import prismaMock from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
} from "@/lib/api-helpers";
import { PATCH } from "../../app/api/properties/sale-dm/drafts/[id]/route";

// 本文の検証は貼り付け・一括適用(PR-D2)と同じ関数を通す。1宛先ずつの編集で迂回できると、
// 白紙やプレースホルダ入りの手紙がそのまま印刷・郵送される(設計 §2.3)。

const pm = prismaMock as never as {
  dmRecipientDraft: {
    findUnique: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  dmVariant: { findFirst: ReturnType<typeof vi.fn> };
};

const RESOURCES = ["property", "csv_export", "csv_export_personal", "owner"];
const ctx = { params: Promise.resolve({ id: "d1" }) };
const patch = (b: unknown) =>
  new Request("http://x", { method: "PATCH", body: JSON.stringify(b) });

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "u1",
    role: "admin",
  });
  (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue([
    ...RESOURCES.map((r) => ({ resource: r, action: "read", granted: true })),
    { resource: "property", action: "write", granted: true },
  ]);
  (getOwnerDisplayConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
    name: "full",
    zip: "full",
    address: "full",
    nameKana: "full",
  });
  pm.dmRecipientDraft.findUnique.mockResolvedValue({
    id: "d1",
    campaignId: "c1",
    status: "confirmed",
    variantId: "vA",
    campaign: { createdBy: "u1" },
    property: { createdBy: "u1", assignedTo: null },
  });
  pm.dmRecipientDraft.updateMany.mockResolvedValue({ count: 1 });
});

describe("PATCH sale-dm draft: 本文の検証", () => {
  it("空白だけの本文は 400(白紙の手紙を作らせない)", async () => {
    const res = await PATCH(patch({ body: "   \n " }) as never, ctx);
    expect(res.status).toBe(400);
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });

  it("差込の記号が残っている本文は 400", async () => {
    const res = await PATCH(patch({ body: "{{所有者名}} 様" }) as never, ctx);
    expect(res.status).toBe(400);
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });

  it("長すぎる本文は 400", async () => {
    const res = await PATCH(patch({ body: "あ".repeat(20_001) }) as never, ctx);
    expect(res.status).toBe(400);
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });

  it("ふつうの本文は従来どおり保存され、確定は解除される", async () => {
    const res = await PATCH(patch({ body: "拝啓" }) as never, ctx);
    expect(res.status).toBe(200);
    const data = pm.dmRecipientDraft.updateMany.mock.calls[0][0].data;
    expect(data.body).toBe("拝啓");
    expect(data.status).toBe("draft");
    expect(data.confirmedAt).toBeNull();
  });

  it("本文を伴わない更新(型の付け替え)は検証の影響を受けない", async () => {
    pm.dmVariant.findFirst.mockResolvedValue({ id: "vB" });
    const res = await PATCH(patch({ variantId: "00000000-0000-4000-8000-000000000002" }) as never, ctx);
    expect(res.status).toBe(200);
  });
});
