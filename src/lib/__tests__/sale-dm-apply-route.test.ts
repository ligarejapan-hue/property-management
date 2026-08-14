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
    dmVariant: { findFirst: vi.fn() },
    dmRecipientDraft: { findMany: vi.fn(), updateMany: vi.fn() },
    // 担当範囲はロックの後に**読み直す**(先読みの値で判定しない・@codex #376 P1)。
    property: { findMany: vi.fn(async () => []) },
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
import { POST } from "../../app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/apply/route";
import { bodyTemplateDigest } from "../sale-dm-letter/external-prompt";

const pm = prismaMock as never as {
  dmCampaign: { findFirst: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
  _tx: {
    dmVariant: { findFirst: ReturnType<typeof vi.fn> };
    dmRecipientDraft: {
      findMany: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    property: { findMany: ReturnType<typeof vi.fn> };
    $queryRaw: ReturnType<typeof vi.fn>;
  };
};

const READS = ["property", "csv_export", "csv_export_personal", "owner"];
const ctx = { params: Promise.resolve({ id: "c1", variantId: "v1" }) };
// 適用も「画面が見ていた原本」を送る（別の画面が差し替えた文面を、古い画面の操作で
// 宛先へ書き込まないため・@codex #376 R16）。既定は beforeEach で仕込む原本と一致する値。
const TEMPLATE = "{{物件所在}}の{{物件種別}}について。拝啓";
const post = (b: Record<string, unknown> = {}) =>
  new Request("http://x", {
    method: "POST",
    body: JSON.stringify({ bodyDigest: bodyTemplateDigest(TEMPLATE), ...b }),
  }) as never;

/** 下書き1件ぶんの模擬（物件の所在・種別・担当を持つ）。 */
function draft(
  id: string,
  over: {
    body?: string;
    status?: string;
    address?: string | null;
    propertyType?: string | null;
    createdBy?: string | null;
    assignedTo?: string | null;
  } = {},
) {
  return {
    id,
    body: over.body ?? "",
    status: over.status ?? "draft",
    propertyId: `p-${id}`,
    property: {
      id: `p-${id}`,
      address: over.address === undefined ? "東京都杉並区西荻北3-19-4" : over.address,
      propertyType: over.propertyType === undefined ? "land" : over.propertyType,
      createdBy: over.createdBy === undefined ? "u1" : over.createdBy,
      assignedTo: over.assignedTo === undefined ? null : over.assignedTo,
    },
  };
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
  pm._tx.dmVariant.findFirst.mockResolvedValue({
    id: "v1",
    bodyTemplate: TEMPLATE,
  });
  pm._tx.dmRecipientDraft.findMany.mockResolvedValue([draft("d1")]);
  pm._tx.property.findMany.mockImplementation(
    async (args: { where: { id: { in: string[] } } }) =>
      args.where.id.in.map((id) => ({
        id,
        createdBy: "u1",
        assignedTo: null,
        address: "東京都杉並区西荻北3-19-4",
        propertyType: "land",
      })),
  );
  pm._tx.dmRecipientDraft.updateMany.mockImplementation(
    async (args: { where: { id: { in: string[] } } }) => ({
      count: args.where.id.in.length,
    }),
  );
});

describe("POST sale-dm variant apply（その型の全宛先へ適用）", () => {
  it("差込タグを物件ごとの値に置き換えて書き込む", async () => {
    const res = await POST(post(), ctx);
    expect(res.status).toBe(200);
    const arg = pm._tx.dmRecipientDraft.updateMany.mock.calls[0][0];
    expect(arg.data.body).toBe("東京都杉並区西荻北の土地について。拝啓");
    expect(arg.where.id.in).toEqual(["d1"]);
  });

  it("同じ本文になる宛先はまとめて1回で書く(N+1にしない)", async () => {
    pm._tx.dmRecipientDraft.findMany.mockResolvedValue([
      draft("d1"),
      draft("d2"),
    ]);
    await POST(post(), ctx);
    expect(pm._tx.dmRecipientDraft.updateMany).toHaveBeenCalledTimes(1);
    expect(
      pm._tx.dmRecipientDraft.updateMany.mock.calls[0][0].where.id.in.sort(),
    ).toEqual(["d1", "d2"]);
  });

  it("既定は本文が空の宛先だけ・上書き指定で下書き状態の全件", async () => {
    await POST(post(), ctx);
    expect(pm._tx.dmRecipientDraft.findMany.mock.calls[0][0].where.body).toEqual(
      "",
    );
    vi.clearAllMocks();
    pm.dmCampaign.findFirst.mockResolvedValue({ id: "c1" });
    pm._tx.dmVariant.findFirst.mockResolvedValue({
      id: "v1",
      bodyTemplate: "拝啓",
    });
    pm._tx.dmRecipientDraft.findMany.mockResolvedValue([draft("d1")]);
    pm._tx.dmRecipientDraft.updateMany.mockResolvedValue({ count: 1 });
    await POST(post({ overwriteExisting: true, bodyDigest: bodyTemplateDigest("拝啓") }), ctx);
    expect(
      pm._tx.dmRecipientDraft.findMany.mock.calls[0][0].where.body,
    ).toBeUndefined();
  });

  it("画面が見ていた原本と違えば適用しない(409・@codex #376 R16)", async () => {
    // ⚠適用は「いまの原本」を差し込む。別の画面が差し替えたあとに古い画面で押すと、
    //   **操作した人が見ていない文面**が宛先に書き込まれる(上書き指定なら手直しごと)。
    const res = await POST(post({ bodyDigest: bodyTemplateDigest("古い文面") }), ctx);
    expect(res.status).toBe(409);
    const b = (await res.json()) as { error: { code: string } };
    expect(b.error.code).toBe("TEMPLATE_STALE");
    expect(pm._tx.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });

  it("確定済み・送付済みには触らない", async () => {
    await POST(post(), ctx);
    const where = pm._tx.dmRecipientDraft.findMany.mock.calls[0][0].where;
    expect(where.status).toEqual("draft");
  });

  it("所在が無い物件はタグを解決できないので飛ばし、件数で報告する", async () => {
    pm._tx.dmRecipientDraft.findMany.mockResolvedValue([draft("d1"), draft("d2")]);
    // 差し込みはロック後に読み直した値で行う（@codex #376 R2 P2）。
    pm._tx.property.findMany.mockResolvedValue([
      { id: "p-d1", createdBy: "u1", assignedTo: null, address: "東京都杉並区西荻北3-19-4", propertyType: "land" },
      { id: "p-d2", createdBy: "u1", assignedTo: null, address: null, propertyType: "land" },
    ]);
    const res = await POST(post(), ctx);
    const body = (await res.json()) as {
      appliedCount: number;
      skippedTagCount: number;
    };
    expect(body.appliedCount).toBe(1);
    expect(body.skippedTagCount).toBe(1);
    expect(
      pm._tx.dmRecipientDraft.updateMany.mock.calls[0][0].where.id.in,
    ).toEqual(["d1"]);
  });

  it("現地担当の担当外の宛先は飛ばし、件数で報告する(残りには適用する)", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "u1",
      role: "field_staff",
    });
    pm._tx.dmRecipientDraft.findMany.mockResolvedValue([
      draft("d1"),
      draft("d2", { createdBy: "other", assignedTo: "other" }),
    ]);
    // 判定も差し込みもロック後の読み直しで行う(@codex #376 P1/P2)。
    pm._tx.property.findMany.mockResolvedValue([
      { id: "p-d1", createdBy: "u1", assignedTo: null, address: "東京都杉並区西荻北3-19-4", propertyType: "land" },
      { id: "p-d2", createdBy: "other", assignedTo: "other", address: "東京都杉並区西荻北3-19-4", propertyType: "land" },
    ]);
    const res = await POST(post(), ctx);
    const body = (await res.json()) as {
      appliedCount: number;
      skippedScopeCount: number;
    };
    expect(body.appliedCount).toBe(1);
    expect(body.skippedScopeCount).toBe(1);
  });

  it("ロック後に担当が外れていたら、先読みの値ではなく読み直した値で飛ばす(@codex #376 P1)", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "u1",
      role: "field_staff",
    });
    // 先読みの時点では自分の担当。ロックを取ってから読み直したら別人に変わっていた。
    pm._tx.dmRecipientDraft.findMany.mockResolvedValue([draft("d1")]);
    pm._tx.property.findMany.mockResolvedValue([
      { id: "p-d1", createdBy: "other", assignedTo: "other", address: "東京都杉並区西荻北3-19-4", propertyType: "land" },
    ]);
    const res = await POST(post(), ctx);
    const body = (await res.json()) as {
      appliedCount: number;
      skippedScopeCount: number;
    };
    expect(body.appliedCount).toBe(0);
    expect(body.skippedScopeCount).toBe(1);
    expect(pm._tx.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });

  it("既定(上書きしない)のとき、書き込み条件にも本文が空であることを残す(@codex #376 P2)", async () => {
    // 読み取り〜書き込みの間に手直しされた本文を、黙って置き換えないため。
    await POST(post(), ctx);
    expect(pm._tx.dmRecipientDraft.updateMany.mock.calls[0][0].where.body).toBe("");
  });

  it("上書き指定のときは本文の条件を付けない(手直し分も置き換える)", async () => {
    await POST(post({ overwriteExisting: true }), ctx);
    expect(
      pm._tx.dmRecipientDraft.updateMany.mock.calls[0][0].where.body,
    ).toBeUndefined();
  });

  it("所在・種別もロック後に読み直した値を差し込む(@codex #376 R2 P2)", async () => {
    // 先読みの値のまま差し込むと、実行中に住所や種別が変わった宛先へ古い内容が刷られる。
    pm._tx.property.findMany.mockResolvedValue([
      {
        id: "p-d1",
        createdBy: "u1",
        assignedTo: null,
        address: "神奈川県横浜市南区井土ケ谷中町69-2",
        propertyType: "house",
      },
    ]);
    await POST(post(), ctx);
    expect(pm._tx.dmRecipientDraft.updateMany.mock.calls[0][0].data.body).toBe(
      "神奈川県横浜市南区井土ケ谷中町の戸建について。拝啓",
    );
  });

  it("本文がまだ保存されていない型は 409(何も書かない)", async () => {
    pm._tx.dmVariant.findFirst.mockResolvedValue({
      id: "v1",
      bodyTemplate: null,
    });
    const res = await POST(post(), ctx);
    expect(res.status).toBe(409);
    expect(pm._tx.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });

  it("型のロックから始める(順序 variant → 物件親行 → draft)", async () => {
    await POST(post(), ctx);
    const sql = pm._tx.$queryRaw.mock.calls
      .map((c: unknown[]) =>
        Array.isArray(c[0]) ? (c[0] as string[]).join("?") : String(c[0]),
      )
      .join(" | ");
    expect(sql).toMatch(/FROM dm_variants[\s\S]*FOR UPDATE/);
  });

  it("編集権限が無ければ 403・処理に入らない", async () => {
    (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(
      READS.map((r) => ({ resource: r, action: "read", granted: true })),
    );
    const res = await POST(post(), ctx);
    expect(res.status).toBe(403);
    expect(pm.$transaction).not.toHaveBeenCalled();
  });

  it("監査に適用・スキップの件数を残す(本文は残さない)", async () => {
    pm._tx.dmRecipientDraft.findMany.mockResolvedValue([draft("d1"), draft("d2")]);
    pm._tx.property.findMany.mockResolvedValue([
      { id: "p-d1", createdBy: "u1", assignedTo: null, address: "東京都杉並区西荻北3-19-4", propertyType: "land" },
      { id: "p-d2", createdBy: "u1", assignedTo: null, address: null, propertyType: "land" },
    ]);
    await POST(post(), ctx);
    const arg = vi.mocked(writeAuditLog).mock.calls[0][0] as {
      action: string;
      detail?: Record<string, unknown>;
    };
    expect(arg.action).toBe("sale_dm_template_apply");
    expect(arg.detail?.appliedCount).toBe(1);
    expect(arg.detail?.skippedTagCount).toBe(1);
    expect(JSON.stringify(arg.detail)).not.toContain("拝啓");
  });
});
