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
  const tx = {
    dmVariant: { findFirst: vi.fn(), update: vi.fn() },
    dmRecipientDraft: { count: vi.fn(), updateMany: vi.fn() },
    $queryRaw: vi.fn(async () => []),
  };
  return {
    default: {
      dmCampaign: { findFirst: vi.fn() },
      $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
      _tx: tx,
    },
  };
});

import { describe, it, expect, beforeEach } from "vitest";
import prismaMock from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
} from "@/lib/api-helpers";
import { PUT } from "../../app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/template/route";
import {
  buildExternalPrompt,
  promptDigest,
} from "../sale-dm-letter/external-prompt";

const pm = prismaMock as never as {
  dmCampaign: { findFirst: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
  _tx: {
    dmVariant: {
      findFirst: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    dmRecipientDraft: {
      count: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    $queryRaw: ReturnType<typeof vi.fn>;
  };
};

const SETTINGS = {
  tone: "formal",
  length: "medium",
  appeal: "price",
  strength: "medium",
};
const DIGEST = promptDigest(buildExternalPrompt(SETTINGS));
const READS = ["property", "csv_export", "csv_export_personal", "owner"];
const ctx = { params: Promise.resolve({ id: "c1", variantId: "v1" }) };
const put = (b: unknown) =>
  new Request("http://x", { method: "PUT", body: JSON.stringify(b) }) as never;

/** 型の状態を差し替える（凍結・保存済み本文）。 */
function armVariant(over: Record<string, unknown> = {}) {
  pm._tx.dmVariant.findFirst.mockResolvedValue({
    id: "v1",
    ...SETTINGS,
    templateFrozenAt: null,
    bodyTemplate: null,
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "u1",
    role: "admin",
  });
  (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue([
    ...READS.map((r) => ({ resource: r, action: "read", granted: true })),
    { resource: "property", action: "write", granted: true },
  ]);
  (getOwnerDisplayConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
    name: "full",
    zip: "full",
    address: "full",
    nameKana: "full",
  });
  pm.dmCampaign.findFirst.mockResolvedValue({ id: "c1" });
  armVariant();
  // settledCount(確定/送付済み) と outOfScope(担当外の未確定) の2種類を数える。
  pm._tx.dmRecipientDraft.count.mockResolvedValue(0);
  pm._tx.dmVariant.update.mockResolvedValue({ id: "v1" });
  pm._tx.dmRecipientDraft.updateMany.mockResolvedValue({ count: 0 });
});

describe("PUT sale-dm variant template（本文の貼り付け保存）", () => {
  it("保存すると原本と、表示したプロンプトの控えが同じ処理で入る", async () => {
    const res = await PUT(put({ body: "拝啓 本文", promptDigest: DIGEST }), ctx);
    expect(res.status).toBe(200);
    const data = pm._tx.dmVariant.update.mock.calls[0][0].data;
    expect(data.bodyTemplate).toBe("拝啓 本文");
    expect(typeof data.promptText).toBe("string");
    expect(data.promptText.length).toBeGreaterThan(0);
  });

  it("差し替え保存は未確定の下書きの本文を同じ処理でクリアする(新旧の混在を防ぐ)", async () => {
    await PUT(put({ body: "拝啓 本文", promptDigest: DIGEST }), ctx);
    const arg = pm._tx.dmRecipientDraft.updateMany.mock.calls[0][0];
    expect(arg.data.body).toBe("");
    expect(arg.data.status).toBe("draft");
  });

  it("許可タグは通す", async () => {
    const res = await PUT(
      put({ body: "{{物件所在}}の{{物件種別}}", promptDigest: DIGEST }),
      ctx,
    );
    expect(res.status).toBe(200);
  });

  it("知らないタグ・空白だけ・長すぎる本文は 400(保存しない)", async () => {
    for (const body of ["{{所有者名}}", "   ", "あ".repeat(20_001)]) {
      vi.clearAllMocks();
      pm.dmCampaign.findFirst.mockResolvedValue({ id: "c1" });
      armVariant();
      pm._tx.dmRecipientDraft.count.mockResolvedValue(0);
      const res = await PUT(put({ body, promptDigest: DIGEST }), ctx);
      expect(res.status).toBe(400);
      expect(pm._tx.dmVariant.update).not.toHaveBeenCalled();
    }
  });

  it("表示したときと設定が変わっていたら 409(指紋の不一致)", async () => {
    const res = await PUT(
      put({ body: "拝啓 本文", promptDigest: "0".repeat(64) }),
      ctx,
    );
    expect(res.status).toBe(409);
    const b = (await res.json()) as { error: { code: string } };
    expect(b.error.code).toBe("PROMPT_STALE");
    expect(pm._tx.dmVariant.update).not.toHaveBeenCalled();
  });

  it("凍結済みの型は差し替えできない 409(送付済み文面の出所を守る)", async () => {
    armVariant({ bodyTemplate: "古い本文" });
    pm._tx.dmRecipientDraft.count.mockResolvedValue(1); // 配下に確定/送付済み
    const res = await PUT(put({ body: "新しい本文", promptDigest: DIGEST }), ctx);
    expect(res.status).toBe(409);
    const b = (await res.json()) as { error: { code: string } };
    expect(b.error.code).toBe("VARIANT_FROZEN");
    expect(pm._tx.dmVariant.update).not.toHaveBeenCalled();
  });

  it("凍結済みでも中身が同じなら 200(何も書かない・下書きも消さない)", async () => {
    armVariant({ bodyTemplate: "同じ本文" });
    pm._tx.dmRecipientDraft.count.mockResolvedValue(1);
    const res = await PUT(put({ body: "同じ本文", promptDigest: DIGEST }), ctx);
    expect(res.status).toBe(200);
    expect(pm._tx.dmVariant.update).not.toHaveBeenCalled();
    expect(pm._tx.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });

  it("型は variant 行のロックから始める(順序 variant → draft)", async () => {
    await PUT(put({ body: "拝啓 本文", promptDigest: DIGEST }), ctx);
    const sql = pm._tx.$queryRaw.mock.calls
      .map((c: unknown[]) =>
        Array.isArray(c[0]) ? (c[0] as string[]).join("?") : String(c[0]),
      )
      .join(" | ");
    expect(sql).toMatch(/FROM dm_variants[\s\S]*FOR UPDATE/);
  });

  it("他人のキャンペーンは 404・処理に入らない", async () => {
    pm.dmCampaign.findFirst.mockResolvedValue(null);
    const res = await PUT(put({ body: "拝啓", promptDigest: DIGEST }), ctx);
    expect(res.status).toBe(404);
    expect(pm.$transaction).not.toHaveBeenCalled();
  });

  it("編集権限が無ければ 403・処理に入らない", async () => {
    (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(
      READS.map((r) => ({ resource: r, action: "read", granted: true })),
    );
    const res = await PUT(put({ body: "拝啓", promptDigest: DIGEST }), ctx);
    expect(res.status).toBe(403);
    expect(pm.$transaction).not.toHaveBeenCalled();
  });

  it("監査は1件・本文を残さない", async () => {
    await PUT(put({ body: "拝啓 本文", promptDigest: DIGEST }), ctx);
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(writeAuditLog).mock.calls[0][0] as {
      action: string;
      detail?: Record<string, unknown>;
    };
    expect(arg.action).toBe("sale_dm_body_paste");
    expect(JSON.stringify(arg.detail)).not.toContain("拝啓");
  });
});
