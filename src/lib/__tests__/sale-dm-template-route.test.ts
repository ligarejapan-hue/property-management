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
    dmRecipientDraft: { count: vi.fn(), updateMany: vi.fn(), findMany: vi.fn(async () => []) },
    // 担当範囲はロックの後に読み直す(@codex #376 R2 P1)。
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
import { PUT } from "../../app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/template/route";
import {
  buildExternalPrompt,
  promptDigest,
  bodyTemplateDigest,
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
      findMany: ReturnType<typeof vi.fn>;
    };
    property: { findMany: ReturnType<typeof vi.fn> };
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
// 保存は「表示したときの設定の指紋」に加えて「そのとき見えていた原本の指紋」も送る
// （別のタブが先に保存した文面を黙って上書きしないため・@codex #376 R14）。
// 既定では armVariant で仕込んだ原本と一致する値を自動で入れ、ずれを試すテストだけ明示する。
let armedBody: string | null = null;
const put = (b: Record<string, unknown>) =>
  new Request("http://x", {
    method: "PUT",
    body: JSON.stringify({ baseBodyDigest: bodyTemplateDigest(armedBody), ...b }),
  }) as never;

/** 型の状態を差し替える（凍結・保存済み本文）。 */
function armVariant(over: Record<string, unknown> = {}) {
  armedBody = ("bodyTemplate" in over ? over.bodyTemplate : null) as string | null;
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
    armVariant({ bodyTemplate: "古い本文" }); // 既に原本がある=差し替え
    await PUT(put({ body: "拝啓 本文", promptDigest: DIGEST }), ctx);
    const arg = pm._tx.dmRecipientDraft.updateMany.mock.calls[0][0];
    expect(arg.data.body).toBe("");
    expect(arg.data.status).toBe("draft");
  });

  it("原本がまだ無い型への保存は初期化として通し、下書きを消さない(@codex #376 R2 P2)", async () => {
    // PR-D2 以前からある型は「確定済みの宛先はあるが原本は空」＝凍結だが初期化は要る。
    // ここを断ると、割当でその型へ移された宛先（本文は空）に何も入れられず詰む。
    armVariant({ bodyTemplate: null });
    pm._tx.dmRecipientDraft.count.mockResolvedValue(1); // 凍結（確定済みがある）
    const res = await PUT(put({ body: "はじめての本文", promptDigest: DIGEST }), ctx);
    expect(res.status).toBe(200);
    expect(pm._tx.dmVariant.update.mock.calls[0][0].data.bodyTemplate).toBe(
      "はじめての本文",
    );
    // 消すべき「旧テンプレ由来の本文」が無いので消さない。
    expect(pm._tx.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
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

  it("別のタブが先に保存していたら 409(見えていた原本の指紋が違う・@codex #376 R14)", async () => {
    // ⚠指紋が設定だけを見ていると、2つのタブで同じ値になる。先に保存・適用された文面を、
    //   古い画面からの保存が黙って差し替え、適用済みの下書きまで消してしまう。
    armVariant({ bodyTemplate: "先に保存された本文" });
    const res = await PUT(
      put({
        body: "あとから来た本文",
        promptDigest: DIGEST,
        baseBodyDigest: bodyTemplateDigest(null), // 開いたときは空だと思っていた
      }),
      ctx,
    );
    expect(res.status).toBe(409);
    const b = (await res.json()) as { error: { code: string } };
    expect(b.error.code).toBe("TEMPLATE_STALE");
    expect(pm._tx.dmVariant.update).not.toHaveBeenCalled();
    expect(pm._tx.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });

  it("保存の応答に、保存後の原本の指紋を返す(取り直しの競合を作らない・@codex #376 R15)", async () => {
    armVariant({ bodyTemplate: "古い本文" });
    const res = await PUT(put({ body: "新しい本文", promptDigest: DIGEST }), ctx);
    expect(res.status).toBe(200);
    const b = (await res.json()) as { changed: boolean; bodyDigest: string };
    expect(b.changed).toBe(true);
    expect(b.bodyDigest).toBe(bodyTemplateDigest("新しい本文"));
  });

  it("中身が同じ保存でも、いまの指紋を返す(画面が持ち続けられる)", async () => {
    armVariant({ bodyTemplate: "同じ本文" });
    const res = await PUT(put({ body: "同じ本文", promptDigest: DIGEST }), ctx);
    const b = (await res.json()) as { changed: boolean; bodyDigest: string };
    expect(b.changed).toBe(false);
    expect(b.bodyDigest).toBe(bodyTemplateDigest("同じ本文"));
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

  it("凍結していなくても、中身が同じ保存は何も書かない(@codex #376 R2 P1)", async () => {
    // ⚠差し替えでない保存で未確定の下書きを全消しすると、適用済み・手直し済みの本文が
    //   まとめて失われる。同じ本文なら no-op にする。
    armVariant({ bodyTemplate: "同じ本文" });
    pm._tx.dmRecipientDraft.count.mockResolvedValue(0); // 凍結していない
    const res = await PUT(put({ body: "同じ本文", promptDigest: DIGEST }), ctx);
    expect(res.status).toBe(200);
    expect(pm._tx.dmVariant.update).not.toHaveBeenCalled();
    expect(pm._tx.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });

  it("現地担当は物件をロックして読み直した担当範囲で判定する(@codex #376 R2 P1)", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "u1",
      role: "field_staff",
    });
    pm._tx.dmRecipientDraft.findMany.mockResolvedValue([{ propertyId: "p1" }]);
    // ⚠実DBと同じく where の担当条件で**絞り込む**。絞り込みを再現しないと、
    //   実装が条件を落としてもテストが通ってしまう（空振り）。
    const rows = [{ id: "p1", createdBy: "other", assignedTo: "other" }];
    pm._tx.property.findMany.mockImplementation(
      async (args: {
        where: { OR?: Array<{ createdBy?: string; assignedTo?: string }> };
      }) =>
        rows.filter((r) =>
          (args.where.OR ?? []).some(
            (c) =>
              (c.createdBy !== undefined && c.createdBy === r.createdBy) ||
              (c.assignedTo !== undefined && c.assignedTo === r.assignedTo),
          ),
        ),
    );
    const res = await PUT(put({ body: "拝啓 本文", promptDigest: DIGEST }), ctx);
    expect(res.status).toBe(403);
    expect(pm._tx.dmVariant.update).not.toHaveBeenCalled();
    const sql = pm._tx.$queryRaw.mock.calls
      .map((c: unknown[]) =>
        Array.isArray(c[0]) ? (c[0] as string[]).join("?") : String(c[0]),
      )
      .join(" | ");
    expect(sql).toMatch(/FROM properties[\s\S]*FOR UPDATE/);
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
