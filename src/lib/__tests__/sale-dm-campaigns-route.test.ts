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
    parseJsonBody: vi.fn(async (r: Request) => { const t = await r.text(); if (t.trim() === "") return {}; try { return JSON.parse(t); } catch { throw new MockApiError(400, "リクエストボディが不正な JSON です", "INVALID_JSON"); } }),
    handleApiError: vi.fn((e: unknown) => e instanceof MockApiError ? Response.json({ error: { message: e.message, code: e.code } }, { status: e.status }) : Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 })),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: {
    property: { findMany: vi.fn() },
    dmCampaign: { create: vi.fn(async () => ({ id: "c1" })), findUnique: vi.fn(async () => null), delete: vi.fn(async () => ({ id: "deleted" })) }, dmVariant: { create: vi.fn() }, dmRecipientDraft: { create: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({
      dmCampaign: { create: vi.fn(async () => ({ id: "c1" })), update: vi.fn() },
      dmVariant: { create: vi.fn(async () => ({ id: "v1" })) },
      dmRecipientDraft: { create: vi.fn() },
    })),
  },
}));

import { describe, it, expect, beforeEach } from "vitest";
import { writeAuditLog } from "@/lib/audit";
import { buildRecipientsFromProperties } from "../sale-dm-letter/recipients";

// dm-export と同じ select 形状の最小 fixture
const ownerDisplayConfig = { name: "full", zip: "full", address: "full", nameKana: "full" } as never;

const property = {
  id: "p1",
  address: "東京都〇〇区△△1-2-3",
  propertyType: "land",
  roomNo: null,
  propertyOwners: [
    { isPrimary: true, relationship: null, owner: { name: "田中 一郎", nameKana: null, zip: "1000001", address: "東京都〇〇区△△1-2-3", corporateNumber: null } },
  ],
};

describe("buildRecipientsFromProperties", () => {
  it("代表者・敬称・物件種別ラベルを持つ recipient を作る", () => {
    const { recipients, meta } = buildRecipientsFromProperties([property as never], ownerDisplayConfig);
    expect(recipients).toHaveLength(1);
    expect(recipients[0].representativeName).toBe("田中 一郎");
    expect(recipients[0].honorific).toBe("様");
    expect(recipients[0].propertyTypeLabel).toBeTruthy();
    expect(meta[0].propertyId).toBe("p1");
    expect(meta[0].recipientAddress).toBe("東京都〇〇区△△1-2-3");
    expect(meta[0].coOwnerCount).toBe(1);
  });
});

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { POST } from "../../app/api/properties/sale-dm/campaigns/route";
import { isSenderConfigured } from "../sale-dm-letter/sender";

// getUserPermissions は { resource, action, granted } の配列を返す(dm-export route test と同形)。
const grant = (...keys: string[]) => (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue([
  ...["property", "csv_export", "csv_export_personal", "owner"].map((r) => ({ resource: r, action: "read", granted: keys.includes(r) })),
  // 有料AI生成の専用権限(action=generate)。明示的に "sale_dm" を渡したときだけ付与。
  { resource: "sale_dm", action: "generate", granted: keys.includes("sale_dm") },
]);
const plain = { name: "full", zip: "full", address: "full", nameKana: "full" };
const req = (b: unknown) => new Request("http://x", { method: "POST", body: JSON.stringify(b) });
const validBody = { name: "テスト", confirmed: true, options: { designTemplate: "formal", tone: "formal", length: "medium", appeal: "price", strength: "low", senderName: "△△", senderContact: "000" } };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_USE_MOCK = "true"; // generation を mock provider + 設定済みに
  // 印刷必須URL(郵送QRの絶対URL)。未設定だと生成前に 503(印刷不能な下書きへの課金を防ぐ)。
  process.env.SALE_DM_TRACKING_BASE_URL = "https://app.example.com";
  process.env.SALE_DM_LP_URL = "https://lp.example.com";
  process.env.SALE_DM_SENDER_NAME = "△△不動産"; // 差出人 env(R33: 差出人は env 必須・body は使わない)
  process.env.SALE_DM_SENDER_CONTACT = "03-0000-0000";
  (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1" });
  (getOwnerDisplayConfig as ReturnType<typeof vi.fn>).mockResolvedValue(plain);
  (prismaMock as never as { property: { findMany: ReturnType<typeof vi.fn> } }).property.findMany.mockResolvedValue([]);
});

describe("POST /api/properties/sale-dm/campaigns", () => {
  it("権限不足(property:read なし)で 403・生成も保存もしない", async () => {
    grant("csv_export", "csv_export_personal", "owner");
    const res = await POST(req(validBody) as never);
    expect(res.status).toBe(403);
    expect(writeAuditLog).not.toHaveBeenCalled();
    expect((prismaMock as never as { $transaction: ReturnType<typeof vi.fn> }).$transaction).not.toHaveBeenCalled();
  });

  it("0件対象でも 200・campaignId を返す", async () => {
    grant("property", "csv_export", "csv_export_personal", "owner", "sale_dm");
    const res = await POST(req(validBody) as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.campaignId).toBe("c1");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("env 未設定(mock off + provider 未設定)で 503", async () => {
    delete process.env.NEXT_PUBLIC_USE_MOCK;
    grant("property", "csv_export", "csv_export_personal", "owner", "sale_dm");
    const res = await POST(req(validBody) as never);
    expect(res.status).toBe(503);
    expect(writeAuditLog).not.toHaveBeenCalled();
    expect((prismaMock as never as { $transaction: ReturnType<typeof vi.fn> }).$transaction).not.toHaveBeenCalled();
  });

  it("不正な JSON ボディは 400(500 でなく)・生成も保存もしない", async () => {
    grant("property", "csv_export", "csv_export_personal", "owner", "sale_dm");
    const res = await POST(new Request("http://x", { method: "POST", body: "{ broken" }) as never);
    expect(res.status).toBe(400);
    expect((prismaMock as never as { $transaction: ReturnType<typeof vi.fn> }).$transaction).not.toHaveBeenCalled();
  });

  it("sale_dm:generate なし(read系のみ)では 403・生成も保存もしない(有料AIの専用権限を必須化)", async () => {
    grant("property", "csv_export", "csv_export_personal", "owner"); // sale_dm を渡さない
    const res = await POST(req(validBody) as never);
    expect(res.status).toBe(403);
    expect(writeAuditLog).not.toHaveBeenCalled();
    expect((prismaMock as never as { $transaction: ReturnType<typeof vi.fn> }).$transaction).not.toHaveBeenCalled();
  });

  it("課金確認なし(confirmed 未指定)で 400・生成も保存もしない", async () => {
    grant("property", "csv_export", "csv_export_personal", "owner", "sale_dm");
    const { confirmed, ...noConfirm } = validBody; // confirmed を外す
    void confirmed;
    const res = await POST(req(noConfirm) as never);
    expect(res.status).toBe(400);
    expect((prismaMock as never as { $transaction: ReturnType<typeof vi.fn> }).$transaction).not.toHaveBeenCalled();
  });

  it("送付可(send)以外の dmStatus 絞り込みでは 400・生成しない(確認対象と実際の生成対象のズレを防ぐ)", async () => {
    grant("property", "csv_export", "csv_export_personal", "owner", "sale_dm");
    const res = await POST(req({ ...validBody, filters: { dmStatus: "hold" } }) as never);
    expect(res.status).toBe(400);
    expect((prismaMock as never as { $transaction: ReturnType<typeof vi.fn> }).$transaction).not.toHaveBeenCalled();
  });

  it("印刷必須URL(SALE_DM_TRACKING_BASE_URL/LP)未設定では生成前に 503・課金しない", async () => {
    delete process.env.SALE_DM_TRACKING_BASE_URL; // 郵送QRの絶対URLが無い=印刷不能
    grant("property", "csv_export", "csv_export_personal", "owner", "sale_dm");
    const res = await POST(req(validBody) as never);
    expect(res.status).toBe(503);
    expect((prismaMock as never as { $transaction: ReturnType<typeof vi.fn> }).$transaction).not.toHaveBeenCalled();
  });

  it("差出人(SALE_DM_SENDER_NAME/CONTACT)が body・env とも未設定なら生成前に 503・課金しない", async () => {
    delete process.env.SALE_DM_SENDER_NAME;
    delete process.env.SALE_DM_SENDER_CONTACT;
    grant("property", "csv_export", "csv_export_personal", "owner", "sale_dm");
    // body も差出人を持たない(UI は差出人を送らない=env 既定に依存)。env も無いと「差出人名 未設定」入りの
    // 使えない手紙を有料生成してしまうため、生成前に fail-closed する(印刷URL チェックと同方針)。
    const noSender = { name: "テスト", confirmed: true, options: { designTemplate: "formal", tone: "formal", length: "medium", appeal: "price", strength: "low" } };
    const res = await POST(req(noSender) as never);
    expect(res.status).toBe(503);
    expect((prismaMock as never as { $transaction: ReturnType<typeof vi.fn> }).$transaction).not.toHaveBeenCalled();
  });

  it("差出人を body で渡しても env 未設定なら 503(body 差出人は保存されず印刷とズレる→env 必須・Codex R33)", async () => {
    delete process.env.SALE_DM_SENDER_NAME;
    delete process.env.SALE_DM_SENDER_CONTACT;
    grant("property", "csv_export", "csv_export_personal", "owner", "sale_dm");
    // validBody は options に senderName/senderContact(=body 差出人)を含む。それでも env 未設定なら 503。
    const res = await POST(req(validBody) as never);
    expect(res.status).toBe(503);
    expect((prismaMock as never as { dmCampaign: { create: ReturnType<typeof vi.fn> } }).dmCampaign.create).not.toHaveBeenCalled();
  });

  it("生成成功後の保存(transaction)失敗ならクレームを削除する(孤児の空 campaign を残さない・Codex R33)", async () => {
    grant("property", "csv_export", "csv_export_personal", "owner", "sale_dm");
    const pmc = prismaMock as never as { dmCampaign: { create: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> }; $transaction: ReturnType<typeof vi.fn>; property: { findMany: ReturnType<typeof vi.fn> } };
    pmc.property.findMany.mockResolvedValue([property]); // 1件→生成→保存トランザクションに到達
    pmc.$transaction.mockRejectedValueOnce(new Error("FK write failed"));
    const res = await POST(req({ ...validBody, idempotencyKey: "key-tx" }) as never);
    expect(res.status).toBe(500);
    expect(pmc.dmCampaign.delete).toHaveBeenCalledWith({ where: { id: "c1" } }); // クレームを削除して孤児を残さない
  });

  it("冪等性キー: 同キーで既に作成済みなら再生成せず既存を返す(二重課金・二重作成の防止)", async () => {
    grant("property", "csv_export", "csv_export_personal", "owner", "sale_dm");
    const pmc = prismaMock as never as { dmCampaign: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> }; $transaction: ReturnType<typeof vi.fn> };
    pmc.dmCampaign.findUnique.mockResolvedValueOnce({ id: "c-existing", createdBy: "u1", status: "ready" });
    const res = await POST(req({ ...validBody, idempotencyKey: "key-1" }) as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.campaignId).toBe("c-existing");
    expect(json.idempotent).toBe(true);
    expect(pmc.dmCampaign.create).not.toHaveBeenCalled(); // クレーム=有料生成を実行しない
    expect(pmc.$transaction).not.toHaveBeenCalled();
  });

  it("冪等性キー: 並行クレーム競合(create が P2002)なら勝者の既存を返す(敗者は生成しない)", async () => {
    grant("property", "csv_export", "csv_export_personal", "owner", "sale_dm");
    const pmc = prismaMock as never as { dmCampaign: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> }; $transaction: ReturnType<typeof vi.fn> };
    pmc.dmCampaign.findUnique
      .mockResolvedValueOnce(null) // 事前チェック: まだ無い
      .mockResolvedValueOnce({ id: "c-won", createdBy: "u1", status: "ready" }); // P2002 後の再取得=勝者(完了済み)
    pmc.dmCampaign.create.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    const res = await POST(req({ ...validBody, idempotencyKey: "key-2" }) as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.campaignId).toBe("c-won");
    expect(pmc.$transaction).not.toHaveBeenCalled(); // 敗者は生成・保存しない
  });

  it("冪等性キー: 孤児(status=draft の空 campaign)が見つかれば削除して作り直す(空キャンペーン固着を防ぐ・R34)", async () => {
    grant("property", "csv_export", "csv_export_personal", "owner", "sale_dm");
    const pmc = prismaMock as never as { dmCampaign: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> } };
    // クレーム後・保存完了前にプロセスが落ちた孤児(status=draft かつ生成時間を大きく超えて古い)が残っている。
    pmc.dmCampaign.findUnique.mockResolvedValueOnce({ id: "c-orphan", createdBy: "u1", status: "draft", createdAt: new Date("2020-01-01T00:00:00Z") });
    const res = await POST(req({ ...validBody, idempotencyKey: "key-orphan" }) as never);
    expect(res.status).toBe(200);
    expect(pmc.dmCampaign.delete).toHaveBeenCalledWith({ where: { id: "c-orphan" } }); // 古い孤児を削除して
    expect(pmc.dmCampaign.create).toHaveBeenCalled(); // 作り直す(再クレーム+生成+保存)
    const json = await res.json();
    expect(json.campaignId).toBe("c1");
  });

  it("冪等性キー: 進行中(新しい draft)のクレームは削除せず 409(ライブの並行生成を壊さず二重課金を防ぐ・Codex)", async () => {
    grant("property", "csv_export", "csv_export_personal", "owner", "sale_dm");
    const pmc = prismaMock as never as { dmCampaign: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> }; $transaction: ReturnType<typeof vi.fn> };
    // 新しい draft = 別リクエストが今まさに生成中。削除すると同キーで二重生成になるため、消さず 409 で再試行を促す。
    pmc.dmCampaign.findUnique.mockResolvedValueOnce({ id: "c-live", createdBy: "u1", status: "draft", createdAt: new Date() });
    const res = await POST(req({ ...validBody, idempotencyKey: "key-live" }) as never);
    expect(res.status).toBe(409);
    expect(pmc.dmCampaign.delete).not.toHaveBeenCalled(); // ライブのクレームを消さない
    expect(pmc.dmCampaign.create).not.toHaveBeenCalled(); // 二重生成しない
    expect(pmc.$transaction).not.toHaveBeenCalled();
  });

  it("冪等性キー: 新規キーはクレーム→生成→保存し、キーを campaign に保存する", async () => {
    grant("property", "csv_export", "csv_export_personal", "owner", "sale_dm");
    const pmc = prismaMock as never as { dmCampaign: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> } };
    const res = await POST(req({ ...validBody, idempotencyKey: "key-3" }) as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.campaignId).toBe("c1");
    expect(pmc.dmCampaign.create).toHaveBeenCalled(); // クレーム実行
    const claimArg = pmc.dmCampaign.create.mock.calls[0][0];
    expect(claimArg.data.idempotencyKey).toBe("key-3"); // キーを保存(生成前にクレーム)
  });
});

describe("isSenderConfigured", () => {
  it("env(SALE_DM_SENDER_NAME/CONTACT)が両方あれば true・片方でも欠ければ false", () => {
    process.env.SALE_DM_SENDER_NAME = "△△不動産";
    process.env.SALE_DM_SENDER_CONTACT = "03-0000-0000";
    expect(isSenderConfigured()).toBe(true);
    delete process.env.SALE_DM_SENDER_CONTACT;
    expect(isSenderConfigured()).toBe(false);
    delete process.env.SALE_DM_SENDER_NAME;
    expect(isSenderConfigured()).toBe(false);
  });
});
