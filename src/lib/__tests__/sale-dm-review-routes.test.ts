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
  // 確定は「所有者をロックした同じ処理の中で宛先を読み直す」ため tx を使う。
  const tx = {
    dmRecipientDraft: { findMany: vi.fn(), updateMany: vi.fn() },
    owner: { findMany: vi.fn() },
    // 確定は field_staff のとき、物件親行をロックしたまま担当範囲を見直す(PR-D1)。
    property: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => []),
  };
  return {
    default: {
      dmCampaign: { findUnique: vi.fn() },
      dmRecipientDraft: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
      dmVariant: { findUnique: vi.fn() },
      $transaction: vi.fn(async (fn) => fn(tx)),
      _tx: tx,
    },
  };
});
vi.mock("@/lib/sale-dm-letter", () => ({ isSaleDmConfigured: vi.fn(), generateLetters: vi.fn(), resolveProvider: vi.fn() }));
vi.mock("@/lib/sale-dm-letter/sender", () => ({ resolveSender: vi.fn(() => ({ senderName: "△△不動産", senderContact: "000" })), isSenderConfigured: vi.fn(() => true) }));

import { describe, it, expect, beforeEach } from "vitest";
import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { isSaleDmConfigured, generateLetters } from "@/lib/sale-dm-letter";
import { isSenderConfigured } from "@/lib/sale-dm-letter/sender";
import { writeAuditLog } from "@/lib/audit";
import { GET as getCampaign } from "../../app/api/properties/sale-dm/campaigns/[id]/route";
import { PATCH as patchDraft } from "../../app/api/properties/sale-dm/drafts/[id]/route";
import { POST as confirmDrafts } from "../../app/api/properties/sale-dm/drafts/confirm/route";
import { POST as regenerateDraft } from "../../app/api/properties/sale-dm/drafts/[id]/regenerate/route";

const pm = prismaMock as never as {
  dmCampaign: { findUnique: ReturnType<typeof vi.fn> };
  dmRecipientDraft: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
  _tx: {
    dmRecipientDraft: { findMany: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
    owner: { findMany: ReturnType<typeof vi.fn> };
    property: { findMany: ReturnType<typeof vi.fn> };
  };
};

/** 宛先が変わっていない下書き（確定できる状態）を1件用意する。 */
function setupFreshDrafts(
  drafts: Array<{
    id: string;
    recipientZip: string | null;
    recipientAddress: string | null;
    ownerId: string;
  }>,
  owners: Array<{
    id: string;
    zip: string | null;
    address: string | null;
    currentZip: string | null;
    currentAddress: string | null;
  }>,
) {
  pm._tx.dmRecipientDraft.findMany.mockResolvedValue(
    drafts.map((d) => ({
      id: d.id,
      recipientZip: d.recipientZip,
      recipientAddress: d.recipientAddress,
      representativeOwnerId: d.ownerId,
      draftOwners: [{ ownerId: d.ownerId }],
      // 確定 tx が variant → 物件親行の順にロックするため、両 id を返す(PR-D1)。
      variantId: "vvvvvvvv-1111-4111-8111-111111111111",
      propertyId: `pppppppp-1111-4111-8111-${d.id.slice(-12)}`,
    })),
  );
  // 既定は「担当範囲が変わっていない」= 全物件が見える。
  pm._tx.property.findMany.mockResolvedValue(
    drafts.map((d) => ({ id: `pppppppp-1111-4111-8111-${d.id.slice(-12)}` })),
  );
  pm._tx.owner.findMany.mockResolvedValue(owners);
  pm._tx.dmRecipientDraft.updateMany.mockResolvedValue({
    count: drafts.length,
  });
}
const grant = (...keys: string[]) => (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue([
  ...["property", "csv_export", "csv_export_personal", "owner"].map((r) => ({ resource: r, action: "read", granted: keys.includes(r) })),
  { resource: "property", action: "write", granted: true },
  // 有料AI生成の専用権限(action=generate)。regenerate route が要求する。
  { resource: "sale_dm", action: "generate", granted: keys.includes("sale_dm") },
]);
const ALL = ["property", "csv_export", "csv_export_personal", "owner", "sale_dm"];

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1" });
  (getOwnerDisplayConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
  // 差出人ゲートの既定は「設定済み」。clearAllMocks は実装(mockReturnValue)を戻さないため、
  // 個別テストで false にした後も他テストへ漏れないよう毎回 true に戻す。
  (isSenderConfigured as ReturnType<typeof vi.fn>).mockReturnValue(true);
  // 再生成の印刷URLゲート(R34)。この test は tracking を mock せず実体(env 判定)を使うため env を設定。
  process.env.SALE_DM_TRACKING_BASE_URL = "https://app.example.com";
  process.env.SALE_DM_LP_URL = "https://lp.example.com";
});

describe("GET campaign", () => {
  it("権限ありで 200・no-store・campaign+drafts を返す(trackingToken は応答に載せない)", async () => {
    grant(...ALL);
    pm.dmCampaign.findUnique.mockResolvedValue({ id: "c1", name: "x", createdBy: "u1", variants: [], recipients: [{ id: "r1", body: "本文", trackingToken: "secret-tok", status: "sent" }] });
    const res = await getCampaign(new Request("http://x") as never, { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const json = await res.json();
    // trackingToken を返すと公開 /t/<token> を直接叩いて反響を捏造できるため、応答に含めない。
    expect(json.campaign.recipients[0].id).toBe("r1");
    expect(json.campaign.recipients[0].trackingToken).toBeUndefined();
  });
  it("field_staff は担当外物件の宛先PIIを返さない・scope判定用propertyは応答に載せない", async () => {
    grant(...ALL);
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1", role: "field_staff" });
    pm.dmCampaign.findUnique.mockResolvedValue({
      id: "c1", name: "x", createdBy: "u1", variants: [],
      recipients: [
        { id: "r1", body: "b1", property: { createdBy: "u1", assignedTo: "x" } }, // 作成者=自分
        { id: "r2", body: "b2", property: { createdBy: "x", assignedTo: "u1" } }, // 担当=自分
        { id: "r3", body: "b3", property: { createdBy: "x", assignedTo: "x" } },  // 担当外→除外
      ],
    });
    const res = await getCampaign(new Request("http://x") as never, { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.campaign.recipients.map((r: { id: string }) => r.id)).toEqual(["r1", "r2"]);
    expect(json.campaign.recipients[0].property).toBeUndefined();
  });
  it("権限不足で 403", async () => {
    grant("property");
    const res = await getCampaign(new Request("http://x") as never, { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(403);
  });
  it("ワークスペース閲覧(宛名/住所/本文PIIを返す)を非PIIメタで監査する(sale_dm_campaign_view・印刷/出力と統一)", async () => {
    grant(...ALL);
    pm.dmCampaign.findUnique.mockResolvedValue({ id: "c1", name: "x", createdBy: "u1", variants: [], recipients: [
      { id: "r1", recipientName: "田中 一郎", recipientAddress: "東京都〇〇区", body: "本文です", status: "sent" },
      { id: "r2", recipientName: "佐藤 花子", recipientAddress: "東京都△△区", body: "本文2", status: "draft" },
    ] });
    const res = await getCampaign(new Request("http://x") as never, { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(200);
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    const arg = (writeAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.action).toBe("sale_dm_campaign_view");
    expect(arg.targetTable).toBe("dm_campaigns");
    expect(arg.targetId).toBe("c1");
    expect(arg.detail.campaignId).toBe("c1");
    expect(arg.detail.count).toBe(2); // 可視宛先数(PII露出件数)
    // 非PII: 宛名・住所・本文を監査 detail に残さない。
    expect(JSON.stringify(arg.detail)).not.toContain("田中");
    expect(JSON.stringify(arg.detail)).not.toContain("本文");
    expect(JSON.stringify(arg.detail)).not.toContain("東京都");
  });
  it("監査件数は field_staff の可視分のみ(担当外の隠れ宛先を数えない)", async () => {
    grant(...ALL);
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1", role: "field_staff" });
    pm.dmCampaign.findUnique.mockResolvedValue({ id: "c1", name: "x", createdBy: "u1", variants: [], recipients: [
      { id: "r1", body: "b1", property: { createdBy: "u1", assignedTo: "x" } },
      { id: "r2", body: "b2", property: { createdBy: "x", assignedTo: "x" } }, // 担当外→不可視
    ] });
    const res = await getCampaign(new Request("http://x") as never, { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(200);
    const arg = (writeAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.detail.count).toBe(1); // r1 のみ可視
  });
  it("権限不足(403)ではワークスペース閲覧を監査しない(PII未露出)", async () => {
    grant("property");
    await getCampaign(new Request("http://x") as never, { params: Promise.resolve({ id: "c1" }) });
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});

describe("PATCH draft (本文編集)", () => {
  it("body を更新し 200(条件付き updateMany で status!=sent をアトミックに)", async () => {
    grant(...ALL);
    pm.dmRecipientDraft.findUnique.mockResolvedValue({ id: "r1", body: "既存", campaignId: "c1", status: "draft", campaign: { createdBy: "u1" } });
    pm.dmRecipientDraft.updateMany.mockResolvedValue({ count: 1 });
    const res = await patchDraft(new Request("http://x", { method: "PATCH", body: JSON.stringify({ body: "編集後" }) }) as never, { params: Promise.resolve({ id: "r1" }) });
    expect(res.status).toBe(200);
    const where = pm.dmRecipientDraft.updateMany.mock.calls[0][0].where;
    expect(where).toEqual({ id: "r1", status: { not: "sent" } });
  });
  it("並行で sent 確定(updateMany count=0)なら 409・上書きしない", async () => {
    grant(...ALL);
    pm.dmRecipientDraft.findUnique.mockResolvedValue({ id: "r1", body: "既存", campaignId: "c1", status: "draft", campaign: { createdBy: "u1" } });
    pm.dmRecipientDraft.updateMany.mockResolvedValue({ count: 0 });
    const res = await patchDraft(new Request("http://x", { method: "PATCH", body: JSON.stringify({ body: "編集後" }) }) as never, { params: Promise.resolve({ id: "r1" }) });
    expect(res.status).toBe(409);
  });
  it("存在しない draft は 404", async () => {
    grant(...ALL);
    pm.dmRecipientDraft.findUnique.mockResolvedValue(null);
    const res = await patchDraft(new Request("http://x", { method: "PATCH", body: JSON.stringify({ body: "編集後" }) }) as never, { params: Promise.resolve({ id: "no-such" }) });
    expect(res.status).toBe(404);
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });
});

describe("POST confirm (bulk)", () => {
  it("指定 id を confirmed にし 200(生成失敗=空bodyは確定対象から除外)", async () => {
    grant(...ALL);
    const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    setupFreshDrafts(
      [
        { id: ids[0], recipientZip: "150-0001", recipientAddress: "渋谷区神宮前1-1-1", ownerId: "aaaaaaaa-1111-4111-8111-111111111111" },
        { id: ids[1], recipientZip: null, recipientAddress: "横浜市南区井土ケ谷中町69-2", ownerId: "bbbbbbbb-2222-4222-8222-222222222222" },
      ],
      [
        { id: "aaaaaaaa-1111-4111-8111-111111111111", zip: "231-0842", address: "横浜市南区旧住所", currentZip: "150-0001", currentAddress: "渋谷区神宮前1-1-1" },
        { id: "bbbbbbbb-2222-4222-8222-222222222222", zip: null, address: "横浜市南区井土ケ谷中町69-2", currentZip: null, currentAddress: null },
      ],
    );
    const res = await confirmDrafts(new Request("http://x", { method: "POST", body: JSON.stringify({ ids }) }) as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.count).toBe(2);
    // 生成失敗(body="")の下書きは確定しない(空letterの確定→印刷→送付を防ぐ)。
    const where = pm._tx.dmRecipientDraft.updateMany.mock.calls[0][0].where;
    expect(where.status).toBe("draft");
    expect(where.body).toEqual({ not: "" });
  });

  it("⚠宛先が変わった下書きは確定させない（409・作り直してもらう）", async () => {
    grant(...ALL);
    // 下書きを作ったあとに現住所が入った＝控えは引っ越し前の住所のまま。
    setupFreshDrafts(
      [{ id: "11111111-1111-4111-8111-111111111111", recipientZip: "231-0842", recipientAddress: "横浜市南区井土ケ谷中町69-2", ownerId: "aaaaaaaa-1111-4111-8111-111111111111" }],
      [{ id: "aaaaaaaa-1111-4111-8111-111111111111", zip: "231-0842", address: "横浜市南区井土ケ谷中町69-2", currentZip: "150-0001", currentAddress: "渋谷区神宮前1-1-1" }],
    );
    const res = await confirmDrafts(new Request("http://x", { method: "POST", body: JSON.stringify({ ids: ["11111111-1111-4111-8111-111111111111"] }) }) as never);
    expect(res.status).toBe(409);
    expect(pm._tx.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });

  it("⚠郵便番号だけ変わった下書きも確定させない", async () => {
    grant(...ALL);
    setupFreshDrafts(
      [{ id: "11111111-1111-4111-8111-111111111111", recipientZip: "231-0842", recipientAddress: "渋谷区神宮前1-1-1", ownerId: "aaaaaaaa-1111-4111-8111-111111111111" }],
      [{ id: "aaaaaaaa-1111-4111-8111-111111111111", zip: null, address: null, currentZip: "150-0001", currentAddress: "渋谷区神宮前1-1-1" }],
    );
    const res = await confirmDrafts(new Request("http://x", { method: "POST", body: JSON.stringify({ ids: ["11111111-1111-4111-8111-111111111111"] }) }) as never);
    expect(res.status).toBe(409);
  });

  it("書き方の違い（ハイフン・前後の空白）では止めない", async () => {
    grant(...ALL);
    setupFreshDrafts(
      [{ id: "11111111-1111-4111-8111-111111111111", recipientZip: "1500001", recipientAddress: " 渋谷区神宮前1-1-1 ", ownerId: "aaaaaaaa-1111-4111-8111-111111111111" }],
      [{ id: "aaaaaaaa-1111-4111-8111-111111111111", zip: null, address: null, currentZip: "150-0001", currentAddress: "渋谷区神宮前1-1-1" }],
    );
    const res = await confirmDrafts(new Request("http://x", { method: "POST", body: JSON.stringify({ ids: ["11111111-1111-4111-8111-111111111111"] }) }) as never);
    expect(res.status).toBe(200);
  });

  it("判定と確定が同じ処理（tx）の中で行われる", async () => {
    grant(...ALL);
    setupFreshDrafts(
      [{ id: "11111111-1111-4111-8111-111111111111", recipientZip: null, recipientAddress: "渋谷区神宮前1-1-1", ownerId: "aaaaaaaa-1111-4111-8111-111111111111" }],
      [{ id: "aaaaaaaa-1111-4111-8111-111111111111", zip: null, address: null, currentZip: null, currentAddress: "渋谷区神宮前1-1-1" }],
    );
    await confirmDrafts(new Request("http://x", { method: "POST", body: JSON.stringify({ ids: ["11111111-1111-4111-8111-111111111111"] }) }) as never);
    expect(pm.$transaction).toHaveBeenCalledTimes(1);
    // tx の外では確定しない（判定後に住所が変わっても素通りしない）。
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });

  it("不正な JSON ボディは 400(500 でなく)・更新しない", async () => {
    grant(...ALL);
    const res = await confirmDrafts(new Request("http://x", { method: "POST", body: "{ broken" }) as never);
    expect(res.status).toBe(400);
    expect(pm._tx.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });

  it("UUID でない id は 422(更新しない)", async () => {
    grant(...ALL);
    const res = await confirmDrafts(new Request("http://x", { method: "POST", body: JSON.stringify({ ids: ["not-a-uuid"] }) }) as never);
    expect(res.status).toBe(422);
    expect(pm._tx.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });

  it("field_staff は作成/担当の物件の宛先のみ確定(where に property record scope を付与)", async () => {
    grant(...ALL);
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1", role: "field_staff" });
    setupFreshDrafts(
      [{ id: "11111111-1111-4111-8111-111111111111", recipientZip: null, recipientAddress: "渋谷区神宮前1-1-1", ownerId: "aaaaaaaa-1111-4111-8111-111111111111" }],
      [{ id: "aaaaaaaa-1111-4111-8111-111111111111", zip: null, address: null, currentZip: null, currentAddress: "渋谷区神宮前1-1-1" }],
    );
    const res = await confirmDrafts(new Request("http://x", { method: "POST", body: JSON.stringify({ ids: ["11111111-1111-4111-8111-111111111111"] }) }) as never);
    expect(res.status).toBe(200);
    const where = pm._tx.dmRecipientDraft.updateMany.mock.calls[0][0].where;
    // 担当外(再割当で隠れた)宛先は DB 側で確定対象から除外される。
    expect(where.property).toEqual({ OR: [{ createdBy: "u1" }, { assignedTo: "u1" }] });
  });

  it("field_staff: ロック後に担当が外れていたら 409(確定させない・PR-D1)", async () => {
    grant(...ALL);
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1", role: "field_staff" });
    setupFreshDrafts(
      [{ id: "11111111-1111-4111-8111-111111111111", recipientZip: null, recipientAddress: "渋谷区神宮前1-1-1", ownerId: "aaaaaaaa-1111-4111-8111-111111111111" }],
      [{ id: "aaaaaaaa-1111-4111-8111-111111111111", zip: null, address: null, currentZip: null, currentAddress: "渋谷区神宮前1-1-1" }],
    );
    // ロックを取ってから見直したら、その物件はもう自分の担当ではなかった。
    pm._tx.property.findMany.mockResolvedValue([]);
    const res = await confirmDrafts(new Request("http://x", { method: "POST", body: JSON.stringify({ ids: ["11111111-1111-4111-8111-111111111111"] }) }) as never);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("SCOPE_CHANGED");
    expect(pm._tx.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });

  it("非 field_staff(管理者等)は confirm に property scope を付与しない", async () => {
    grant(...ALL);
    setupFreshDrafts(
      [{ id: "11111111-1111-4111-8111-111111111111", recipientZip: null, recipientAddress: "渋谷区神宮前1-1-1", ownerId: "aaaaaaaa-1111-4111-8111-111111111111" }],
      [{ id: "aaaaaaaa-1111-4111-8111-111111111111", zip: null, address: null, currentZip: null, currentAddress: "渋谷区神宮前1-1-1" }],
    );
    const res = await confirmDrafts(new Request("http://x", { method: "POST", body: JSON.stringify({ ids: ["11111111-1111-4111-8111-111111111111"] }) }) as never);
    expect(res.status).toBe(200);
    expect(pm._tx.dmRecipientDraft.updateMany.mock.calls[0][0].where.property).toBeUndefined();
  });
});

describe("POST regenerate draft (再生成)", () => {
  const mockDraft = {
    id: "r1",
    recipientName: "田中 一郎",
    honorific: "様",
    coOwnerCount: 1,
    status: "confirmed",
    campaign: { createdBy: "u1" },
    property: { address: "東京都〇〇区", propertyType: "land", roomNo: null },
    variant: { designTemplate: "formal", tone: "formal", length: "medium", appeal: "price", strength: "low", extraInstruction: null },
  };

  it("未設定の場合 503", async () => {
    grant(...ALL);
    (getOwnerDisplayConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
    (isSaleDmConfigured as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const res = await regenerateDraft(new Request("http://x", { method: "POST", body: JSON.stringify({ confirmed: true }) }) as never, { params: Promise.resolve({ id: "r1" }) });
    expect(res.status).toBe(503);
  });

  it("差出人(env)未設定なら 503・生成しない(差出人名/連絡先が空の使えない手紙を有料生成しない)", async () => {
    grant(...ALL);
    (isSaleDmConfigured as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (isSenderConfigured as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const res = await regenerateDraft(new Request("http://x", { method: "POST", body: JSON.stringify({ confirmed: true }) }) as never, { params: Promise.resolve({ id: "r1" }) });
    expect(res.status).toBe(503);
    expect(generateLetters).not.toHaveBeenCalled();
  });

  it("印刷必須URL(env)未設定なら 503・生成しない(印刷不能な下書きへの課金防止・campaign POST と統一・R34)", async () => {
    grant(...ALL);
    (isSaleDmConfigured as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (isSenderConfigured as ReturnType<typeof vi.fn>).mockReturnValue(true);
    delete process.env.SALE_DM_TRACKING_BASE_URL; // 郵送QRの絶対URLが無い=印刷不能
    const res = await regenerateDraft(new Request("http://x", { method: "POST", body: JSON.stringify({ confirmed: true }) }) as never, { params: Promise.resolve({ id: "r1" }) });
    expect(res.status).toBe(503);
    expect(generateLetters).not.toHaveBeenCalled();
  });

  it("課金確認なし(confirmed 未指定)の再生成は 400・生成しない(campaign 作成と同じ確認ゲート)", async () => {
    grant(...ALL);
    (getOwnerDisplayConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
    (isSaleDmConfigured as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const res = await regenerateDraft(new Request("http://x", { method: "POST" }) as never, { params: Promise.resolve({ id: "r1" }) });
    expect(res.status).toBe(400);
    expect(generateLetters).not.toHaveBeenCalled();
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });

  it("draft が存在しない場合 404", async () => {
    grant(...ALL);
    (getOwnerDisplayConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
    (isSaleDmConfigured as ReturnType<typeof vi.fn>).mockReturnValue(true);
    pm.dmRecipientDraft.findUnique.mockResolvedValue(null);
    const res = await regenerateDraft(new Request("http://x", { method: "POST", body: JSON.stringify({ confirmed: true }) }) as never, { params: Promise.resolve({ id: "r1" }) });
    expect(res.status).toBe(404);
  });

  it("field_staff が作成/担当でない物件の再生成は 403(record scope)", async () => {
    grant(...ALL);
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1", role: "field_staff" });
    (getOwnerDisplayConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
    (isSaleDmConfigured as ReturnType<typeof vi.fn>).mockReturnValue(true);
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      ...mockDraft,
      property: { address: "東京都〇〇区", propertyType: "land", roomNo: null, createdBy: "other", assignedTo: "other" },
    });
    const res = await regenerateDraft(new Request("http://x", { method: "POST", body: JSON.stringify({ confirmed: true }) }) as never, { params: Promise.resolve({ id: "r1" }) });
    expect(res.status).toBe(403);
  });

  it("正常に再生成し 200・条件付き updateMany(status!=sent)で本文書込+確定解除(draft へ)", async () => {
    grant(...ALL);
    (getOwnerDisplayConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
    (isSaleDmConfigured as ReturnType<typeof vi.fn>).mockReturnValue(true);
    pm.dmRecipientDraft.findUnique.mockResolvedValue(mockDraft);
    (generateLetters as ReturnType<typeof vi.fn>).mockResolvedValue({ drafts: [{ recipientIndex: 0, body: "再生成本文", error: null }], truncated: false });
    pm.dmRecipientDraft.updateMany.mockResolvedValue({ count: 1 });
    const res = await regenerateDraft(new Request("http://x", { method: "POST", body: JSON.stringify({ confirmed: true }) }) as never, { params: Promise.resolve({ id: "r1" }) });
    expect(res.status).toBe(200);
    // 本文が変わるため確定を解除=再生成後の新文面を再確認なしで印刷/送付させない(承認ゲート維持)。
    // where は status!=sent に加え、生成時の variant options を relational filter で要求する(生成中の型変更で
    // 旧設定本文を書き戻さない=variant 無効化を打ち消さない)。
    expect(pm.dmRecipientDraft.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "r1",
        status: { not: "sent" },
        variant: { designTemplate: "formal", tone: "formal", length: "medium", appeal: "price", strength: "low", extraInstruction: null },
      },
      data: { body: "再生成本文", status: "draft", confirmedAt: null },
    }));
  });

  it("生成中に割当 variant が変更された場合は 409・旧設定本文を書き戻さない(updateMany count=0)", async () => {
    grant(...ALL);
    (getOwnerDisplayConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
    (isSaleDmConfigured as ReturnType<typeof vi.fn>).mockReturnValue(true);
    pm.dmRecipientDraft.findUnique.mockResolvedValue(mockDraft);
    (generateLetters as ReturnType<typeof vi.fn>).mockResolvedValue({ drafts: [{ recipientIndex: 0, body: "再生成本文", error: null }], truncated: false });
    pm.dmRecipientDraft.updateMany.mockResolvedValue({ count: 0 }); // variant options 不一致 or sent 化で 0 行
    const res = await regenerateDraft(new Request("http://x", { method: "POST", body: JSON.stringify({ confirmed: true }) }) as never, { params: Promise.resolve({ id: "r1" }) });
    expect(res.status).toBe(409);
  });

  it("生成中に並行で sent 確定(updateMany count=0)なら 409・本文を上書きしない", async () => {
    grant(...ALL);
    (getOwnerDisplayConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "full", zip: "full", address: "full", nameKana: "full" });
    (isSaleDmConfigured as ReturnType<typeof vi.fn>).mockReturnValue(true);
    pm.dmRecipientDraft.findUnique.mockResolvedValue(mockDraft);
    (generateLetters as ReturnType<typeof vi.fn>).mockResolvedValue({ drafts: [{ recipientIndex: 0, body: "再生成本文", error: null }], truncated: false });
    pm.dmRecipientDraft.updateMany.mockResolvedValue({ count: 0 });
    const res = await regenerateDraft(new Request("http://x", { method: "POST", body: JSON.stringify({ confirmed: true }) }) as never, { params: Promise.resolve({ id: "r1" }) });
    expect(res.status).toBe(409);
  });
});

describe("POST confirm (bulk) — 共有者のまとまりが割れていないか", () => {
  const D = "11111111-1111-4111-8111-111111111111";
  const A = "aaaaaaaa-1111-4111-8111-111111111111";
  const B = "bbbbbbbb-2222-4222-8222-222222222222";

  /** 代表 + 共有者1人の下書き（2人まとめて1通）。 */
  function setupSharedDraft(
    ownerA: Record<string, string | null>,
    ownerB: Record<string, string | null>,
    saved = { recipientZip: "150-0001", recipientAddress: "渋谷区神宮前1-1-1" },
  ) {
    pm._tx.dmRecipientDraft.findMany.mockResolvedValue([
      {
        id: D,
        recipientZip: saved.recipientZip,
        recipientAddress: saved.recipientAddress,
        representativeOwnerId: A,
        draftOwners: [{ ownerId: A }, { ownerId: B }],
      },
    ]);
    pm._tx.owner.findMany.mockResolvedValue([
      { id: A, zip: null, address: null, currentZip: null, currentAddress: null, ...ownerA },
      { id: B, zip: null, address: null, currentZip: null, currentAddress: null, ...ownerB },
    ]);
    pm._tx.dmRecipientDraft.updateMany.mockResolvedValue({ count: 1 });
  }

  const call = () =>
    confirmDrafts(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({ ids: [D] }),
      }) as never,
    );

  it("2人とも同じ宛先のままなら確定できる", async () => {
    grant(...ALL);
    setupSharedDraft(
      { currentZip: "150-0001", currentAddress: "渋谷区神宮前1-1-1" },
      { currentZip: "150-0001", currentAddress: "渋谷区神宮前1-1-1" },
    );
    const res = await call();
    expect(res.status).toBe(200);
  });

  it("⚠代表ではない共有者だけが引っ越したら確定させない（作り直せば2通に割れる）", async () => {
    grant(...ALL);
    setupSharedDraft(
      { currentZip: "150-0001", currentAddress: "渋谷区神宮前1-1-1" },
      // 郵便番号は同じまま・住所だけ別の場所へ（代表の値からは変化が見えない）
      { currentZip: "150-0001", currentAddress: "横浜市南区井土ケ谷中町69-2" },
    );
    const res = await call();
    expect(res.status).toBe(409);
    expect(pm._tx.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
  });
});
