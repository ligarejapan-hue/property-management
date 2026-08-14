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
// 下書き保存の引数(特に model)を検証するため tx 内の create を共有スパイにする。
const { draftCreate, draftOwnerCreateMany, txPropertyOwnerFindMany } = vi.hoisted(() => ({
  draftCreate: vi.fn(),
  draftOwnerCreateMany: vi.fn(),
  txPropertyOwnerFindMany: vi.fn(async () => [] as Array<{ propertyId: string; ownerId: string }>),
}));
vi.mock("@/lib/prisma", () => ({
  default: {
    property: { findMany: vi.fn() },
    dmCampaign: { create: vi.fn(async () => ({ id: "c1" })), findUnique: vi.fn(async () => null), delete: vi.fn(async () => ({ id: "deleted" })), deleteMany: vi.fn(async () => ({ count: 1 })) }, dmVariant: { create: vi.fn() }, dmRecipientDraft: { create: draftCreate },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({
      dmCampaign: { create: vi.fn(async () => ({ id: "c1" })), update: vi.fn() },
      dmVariant: { create: vi.fn(async () => ({ id: "v1" })) },
      dmRecipientDraft: { create: draftCreate },
      // PR-A: 宛先生成 tx のロック(Owner/親行 FOR SHARE)・リンク再検証・共有者連関保存。
      dmRecipientDraftOwner: { createMany: draftOwnerCreateMany },
      propertyOwner: { findMany: txPropertyOwnerFindMany },
      $queryRaw: vi.fn(async () => []),
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
import { MAX_GENERATE_ITEMS, DEFAULT_CONCURRENCY, AI_CALL_TIMEOUT_MS, AI_MAX_RETRIES } from "../sale-dm-letter";
import { saleDmCampaignBodySchema } from "../validators-sale-dm";

// getUserPermissions は { resource, action, granted } の配列を返す(dm-export route test と同形)。
const grant = (...keys: string[]) => (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue([
  ...["property", "csv_export", "csv_export_personal", "owner"].map((r) => ({ resource: r, action: "read", granted: keys.includes(r) })),
  { resource: "property", action: "write", granted: true },
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

  it("propertyIds を渡すと選択物件を対象にし dmStatus=send を強制しない・requested を返す", async () => {
    grant("property", "csv_export", "csv_export_personal", "owner", "sale_dm");
    const findMany = (prismaMock as never as { property: { findMany: ReturnType<typeof vi.fn> } }).property.findMany;
    findMany.mockResolvedValue([property as never]);
    const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    const res = await POST(req({ ...validBody, propertyIds: ids }) as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.campaignId).toBe("c1");
    const whereArg = findMany.mock.calls[0][0].where;
    expect(whereArg.id).toEqual({ in: ids });
    expect(whereArg.dmStatus).toBe("send"); // DMは送付可(send)の物件にのみ生成(未判断/送付不可は除外)
    expect(json.requested).toBe(1); // findMany(住所あり)が1件返る → 対象=1
    expect(json.matchedProperties).toBe(1);
  });

  it("field_staff は propertyIds でも担当範囲(createdBy/assignedTo)に AND される", async () => {
    grant("property", "csv_export", "csv_export_personal", "owner", "sale_dm");
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1", role: "field_staff" });
    const findMany = (prismaMock as never as { property: { findMany: ReturnType<typeof vi.fn> } }).property.findMany;
    findMany.mockResolvedValue([]);
    const res = await POST(req({ ...validBody, propertyIds: ["11111111-1111-4111-8111-111111111111"] }) as never);
    expect(res.status).toBe(200);
    const whereArg = findMany.mock.calls[0][0].where;
    expect(whereArg.AND).toEqual([{ OR: [{ createdBy: "u1" }, { assignedTo: "u1" }] }]);
    expect(whereArg.id).toEqual({ in: ["11111111-1111-4111-8111-111111111111"] });
  });

  it("共有者が別住所の物件は手紙数(requested) > 物件数(matchedProperties)", async () => {
    grant("property", "csv_export", "csv_export_personal", "owner", "sale_dm");
    const twoAddr = {
      id: "p1", address: "東京都〇〇区△△1-2-3", propertyType: "land", roomNo: null,
      propertyOwners: [
        { isPrimary: true, relationship: null, owner: { name: "田中 一郎", nameKana: null, zip: "1000001", address: "東京都〇〇区△△1-2-3", corporateNumber: null } },
        { isPrimary: false, relationship: null, owner: { name: "田中 二郎", nameKana: null, zip: "5300001", address: "大阪府大阪市北区1-1", corporateNumber: null } },
      ],
    };
    (prismaMock as never as { property: { findMany: ReturnType<typeof vi.fn> } }).property.findMany.mockResolvedValue([twoAddr as never]);
    const res = await POST(req({ ...validBody, propertyIds: ["11111111-1111-4111-8111-111111111111"] }) as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.matchedProperties).toBe(1); // 物件は1件
    expect(json.requested).toBe(2); // 手紙は2通(別住所の共有者)
  });

  it("住所が空白のみの物件は対象外として matchedProperties に数えない(空キャンペーン誤誘導を防ぐ・Codex R9-P2)", async () => {
    grant("property", "csv_export", "csv_export_personal", "owner", "sale_dm");
    // DBの address:{not:""} は空白のみを通すが、生成側の grouping は trim して skip する=宛先0。
    const blankAddr = {
      id: "p-blank", address: "東京都〇〇区△△1-2-3", propertyType: "land", roomNo: null,
      propertyOwners: [
        { isPrimary: true, relationship: null, owner: { name: "空白 太郎", nameKana: null, zip: "1000001", address: "   ", corporateNumber: null } },
      ],
    };
    (prismaMock as never as { property: { findMany: ReturnType<typeof vi.fn> } }).property.findMany.mockResolvedValue([property as never, blankAddr as never]);
    const res = await POST(req({ ...validBody, propertyIds: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"] }) as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.matchedProperties).toBe(1); // 宛先を作れた物件のみ(properties.length=2 ではない)
    expect(json.requested).toBe(1); // 空白住所は宛先を作れない
  });

  it("propertyIds でも共有者多数で50通を超える分は物件単位で切り詰める(1物件を分断しない・Codex R9-P1)", async () => {
    grant("property", "csv_export", "csv_export_personal", "owner", "sale_dm");
    // 各物件に「別住所の共有者」を n 人 = n 通に fan-out させる。max: undefined の無制限だと 60通課金になるところ。
    const owners = (pid: string, n: number) => Array.from({ length: n }, (_, i) => ({
      isPrimary: i === 0, relationship: null,
      owner: { name: `${pid}-owner${i}`, nameKana: null, zip: "1000001", address: `東京都〇〇区${pid}-${i}`, corporateNumber: null },
    }));
    const p1 = { id: "p1", address: "A", propertyType: "land", roomNo: null, propertyOwners: owners("p1", 30) };
    const p2 = { id: "p2", address: "B", propertyType: "land", roomNo: null, propertyOwners: owners("p2", 30) };
    (prismaMock as never as { property: { findMany: ReturnType<typeof vi.fn> } }).property.findMany.mockResolvedValue([p1 as never, p2 as never]);
    const res = await POST(req({ ...validBody, propertyIds: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"] }) as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.requested).toBe(60); // 全宛先(30+30)
    expect(json.generated).toBe(30); // p1(30)のみ。p2 を足すと 60>50 なので物件境界で打ち切り(分断しない)
    expect(json.truncated).toBe(true);
    expect(json.matchedProperties).toBe(2); // 対象物件は2件(両方 住所あり)。切詰は truncated で示す
  });

  it("propertyIds は「選択リストの並び」で切り詰める(findMany の並びに依存しない・Codex R13)", async () => {
    grant("property", "csv_export", "csv_export_personal", "owner", "sale_dm");
    const idA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const idB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const owners = (tag: string, n: number) => Array.from({ length: n }, (_, i) => ({
      isPrimary: i === 0, relationship: null,
      owner: { name: `${tag}-o${i}`, nameKana: null, zip: "1000001", address: `東京都〇〇区${tag}-${i}`, corporateNumber: null },
    }));
    const pA = { id: idA, address: "A", propertyType: "land", roomNo: null, propertyOwners: owners("A", 30) };
    const pB = { id: idB, address: "B", propertyType: "land", roomNo: null, propertyOwners: owners("B", 30) };
    // findMany は updatedAt 等で [pB, pA] の順に返す(ユーザーの選択順 [A,B] とは逆)。
    (prismaMock as never as { property: { findMany: ReturnType<typeof vi.fn> } }).property.findMany.mockResolvedValue([pB as never, pA as never]);
    const res = await POST(req({ ...validBody, propertyIds: [idA, idB] }) as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.generated).toBe(30); // 30+30>50 → 物件単位で30通に切詰
    expect(json.truncated).toBe(true);
    // 切り詰めは選択順(先頭=A)を優先。生成された draft の propertyId は全て idA(B は繰り越し)。
    const draftPropertyIds = new Set(draftCreate.mock.calls.map((c) => c[0].data.propertyId));
    expect(draftPropertyIds).toEqual(new Set([idA]));
  });

  it("filters 経路(propertyIds 無し)は従来どおり上限で切り詰める(無制限は propertyIds のみ・Codex P1)", async () => {
    grant("property", "csv_export", "csv_export_personal", "owner", "sale_dm");
    const many = Array.from({ length: 55 }, (_, i) => ({ ...property, id: `p${i}` }));
    (prismaMock as never as { property: { findMany: ReturnType<typeof vi.fn> } }).property.findMany.mockResolvedValue(many as never);
    const res = await POST(req(validBody) as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    // filters:{} での無制限な有料AI生成/PII送信を防ぐため上限(MAX_GENERATE_ITEMS)で切り詰める。
    expect(json.truncated).toBe(true);
    expect(json.generated).toBe(50);
  });

  it("propertyIds 経路は選んだ物件の宛先を全て生成(≤50物件・truncated 無・take 無・Codex R8)", async () => {
    grant("property", "csv_export", "csv_export_personal", "owner", "sale_dm");
    // 選択は配列上限=50物件で件数が閉じるため letter cap を掛けず、共有者ぶんも含め全宛先を生成する(物件を途中で分断しない)。
    const ids = Array.from({ length: 40 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const many = Array.from({ length: 40 }, (_, i) => ({ ...property, id: `p${i}` }));
    const findMany = (prismaMock as never as { property: { findMany: ReturnType<typeof vi.fn> } }).property.findMany;
    findMany.mockResolvedValue(many as never);
    const res = await POST(req({ ...validBody, propertyIds: ids }) as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.truncated).toBe(false); // 切り詰めない(選択=全生成)
    expect(json.generated).toBe(40);
    expect(json.matchedProperties).toBe(40); // take しない=対象物件は全件把握(対象外件数を正確に)
    expect(findMany.mock.calls[0][0].take).toBeUndefined(); // 明示選択は take しない
  });

  it("AIを呼ばないのでモデル名は記録しない(@codex #376 R5)", async () => {
    // 外部AI方式では作成時に本文を作らない。既定のモデル名を書くと、実際には
    // ChatGPT/Gemini や手書きで入れた文面にも「このモデルが作った」という嘘の出所が残る。
    grant("property", "csv_export", "csv_export_personal", "owner", "sale_dm");
    process.env.SALE_DM_LETTER_PROVIDER = "openai";
    (prismaMock as never as { property: { findMany: ReturnType<typeof vi.fn> } }).property.findMany.mockResolvedValue([property as never]);
    const res = await POST(req(validBody) as never);
    expect(res.status).toBe(200);
    expect(draftCreate).toHaveBeenCalled();
    expect(draftCreate.mock.calls[0][0].data.model).toBeNull();
    // 本文も空で作られる（文面は型ごとに貼り付けて適用する）。
    expect(draftCreate.mock.calls[0][0].data.body).toBe("");
  });

  it("印刷の前提(追跡URL/LP/差出人)が未設定なら 503(AI設定はもう見ない・PR-D2)", async () => {
    // AI直結は廃止したので provider/APIキーは要求しない。印刷できない下書きを作らせない
    // ための前提(追跡URL・LP・差出人)だけが 503 の理由として残る(設計 §2.5)。
    delete process.env.NEXT_PUBLIC_USE_MOCK;
    delete process.env.SALE_DM_SENDER_NAME; // 差出人が無い=印刷しても差出人欄が空になる
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

  it("sale_dm:generate は不要になった(外部AI方式は課金もPII外部送信も無い・PR-D2)", async () => {
    // 旧: この権限が無ければ 403。新: 書込門は property:write のみ(設計 §2.5)。
    grant("property", "csv_export", "csv_export_personal", "owner"); // sale_dm を渡さない
    const res = await POST(req(validBody) as never);
    expect(res.status).toBe(200);
  });

  it("課金確認(confirmed)は不要になった(@codex #376 R6)", async () => {
    // この門の根拠は「有料AI呼び出し + オーナーPII の外部送信」だったが、外部AI方式では
    // どちらも起きない。要求を残すと、新しい意味に従う利用者が起きない課金を認めない限り
    // 400 になる。フィールドは後方互換で受けるが判定はしない。
    grant("property", "csv_export", "csv_export_personal", "owner", "sale_dm");
    const { confirmed: _drop, ...noConfirm } = validBody as Record<string, unknown>;
    void _drop;
    const res = await POST(req(noConfirm) as never);
    expect(res.status).toBe(200);
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
    const pmc = prismaMock as never as { dmCampaign: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> } };
    // クレーム後・保存完了前にプロセスが落ちた孤児(status=draft かつ生成時間を大きく超えて古い)が残っている。
    pmc.dmCampaign.findUnique.mockResolvedValueOnce({ id: "c-orphan", createdBy: "u1", status: "draft", createdAt: new Date("2020-01-01T00:00:00Z") });
    const res = await POST(req({ ...validBody, idempotencyKey: "key-orphan" }) as never);
    expect(res.status).toBe(200);
    // ⚠削除は status=draft 条件付き(deleteMany)。無条件 delete だと読み取りと削除の
    // すき間に ready 確定した完成済みキャンペーンをカスケード削除してしまう（総点検P3）。
    expect(pmc.dmCampaign.deleteMany).toHaveBeenCalledWith({ where: { id: "c-orphan", status: "draft" } });
    expect(pmc.dmCampaign.create).toHaveBeenCalled(); // 作り直す(再クレーム+生成+保存)
    const json = await res.json();
    expect(json.campaignId).toBe("c1");
  });

  it("冪等性キー: 孤児削除が count=0 (すき間に ready 確定) なら完成済みを冪等返却し再生成しない（総点検P3）", async () => {
    grant("property", "csv_export", "csv_export_personal", "owner", "sale_dm");
    const pmc = prismaMock as never as { dmCampaign: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> }; $transaction: ReturnType<typeof vi.fn> };
    pmc.dmCampaign.findUnique
      .mockResolvedValueOnce({ id: "c-settled", createdBy: "u1", status: "draft", createdAt: new Date("2020-01-01T00:00:00Z") })
      .mockResolvedValueOnce({ status: "ready" }); // 読み直し=保存 tx が完了していた
    pmc.dmCampaign.deleteMany.mockResolvedValueOnce({ count: 0 });
    const res = await POST(req({ ...validBody, idempotencyKey: "key-settled" }) as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.campaignId).toBe("c-settled");
    expect(json.idempotent).toBe(true);
    expect(pmc.dmCampaign.create).not.toHaveBeenCalled(); // 再クレーム・再生成しない
    expect(pmc.$transaction).not.toHaveBeenCalled();
  });

  it("冪等性キー: 孤児削除が count=0 で読み直しても draft のままなら 409（再試行を促す）", async () => {
    grant("property", "csv_export", "csv_export_personal", "owner", "sale_dm");
    const pmc = prismaMock as never as { dmCampaign: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> } };
    pmc.dmCampaign.findUnique
      .mockResolvedValueOnce({ id: "c-race", createdBy: "u1", status: "draft", createdAt: new Date("2020-01-01T00:00:00Z") })
      .mockResolvedValueOnce(null); // 他リクエストが先に孤児を回収して再クレーム中
    pmc.dmCampaign.deleteMany.mockResolvedValueOnce({ count: 0 });
    const res = await POST(req({ ...validBody, idempotencyKey: "key-race" }) as never);
    expect(res.status).toBe(409);
    expect(pmc.dmCampaign.create).not.toHaveBeenCalled();
  });

  it("冪等性キー: 進行中(新しい draft)のクレームは削除せず 409(ライブの並行生成を壊さず二重課金を防ぐ・Codex)", async () => {
    grant("property", "csv_export", "csv_export_personal", "owner", "sale_dm");
    const pmc = prismaMock as never as { dmCampaign: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> }; $transaction: ReturnType<typeof vi.fn> };
    // 新しい draft = 別リクエストが今まさに生成中。削除すると同キーで二重生成になるため、消さず 409 で再試行を促す。
    pmc.dmCampaign.findUnique.mockResolvedValueOnce({ id: "c-live", createdBy: "u1", status: "draft", createdAt: new Date() });
    const res = await POST(req({ ...validBody, idempotencyKey: "key-live" }) as never);
    expect(res.status).toBe(409);
    expect(pmc.dmCampaign.deleteMany).not.toHaveBeenCalled(); // ライブのクレームを消さない
    expect(pmc.dmCampaign.create).not.toHaveBeenCalled(); // 二重生成しない
    expect(pmc.$transaction).not.toHaveBeenCalled();
  });

  it("冪等性キー: 少し前に作りかけたクレームは進行中扱いで 409(削除しない)", async () => {
    // AI生成を廃止したので、作成は DB 作業だけ＝短い固定窓(2分)で十分(PR-D2)。
    // 窓の中は「進行中」として 409 にし、孤児と誤判定して消さない。
    grant("property", "csv_export", "csv_export_personal", "owner", "sale_dm");
    const pmc = prismaMock as never as { dmCampaign: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> } };
    pmc.dmCampaign.findUnique.mockResolvedValueOnce({ id: "c-slow", createdBy: "u1", status: "draft", createdAt: new Date(Date.now() - 30 * 1000) });
    const res = await POST(req({ ...validBody, idempotencyKey: "key-slow" }) as never);
    expect(res.status).toBe(409);
    expect(pmc.dmCampaign.deleteMany).not.toHaveBeenCalled();
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

describe("saleDmCampaignBodySchema: propertyIds は1回50物件まで", () => {
  const base = { name: "x", confirmed: true, options: { designTemplate: "formal", tone: "formal", length: "medium", appeal: "price", strength: "low" } };
  const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
  it("50件は許可(=生成上限 MAX_GENERATE_ITEMS と一致)", () => {
    expect(() => saleDmCampaignBodySchema.parse({ ...base, propertyIds: Array.from({ length: 50 }, (_, i) => uuid(i)) })).not.toThrow();
  });
  it("51件は弾く(一度に選べる物件は50件まで=切り詰め/分断を起こさない・Codex R8)", () => {
    expect(() => saleDmCampaignBodySchema.parse({ ...base, propertyIds: Array.from({ length: 51 }, (_, i) => uuid(i)) })).toThrow();
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

describe("PR-A: 宛先生成の共有者連関保存(設計§2.2)", () => {
  const propWithIds = {
    id: "p1",
    address: "東京都〇〇区△△1-2-3",
    propertyType: "land",
    roomNo: null,
    propertyOwners: [
      { isPrimary: true, relationship: null, owner: { id: "o1", name: "田中 一郎", nameKana: null, zip: "1000001", address: "東京都X", corporateNumber: null } },
      { isPrimary: false, relationship: null, owner: { id: "o2", name: "田中 花子", nameKana: null, zip: "1000001", address: "東京都X", corporateNumber: null } },
    ],
  };

  it("リンクが現存すれば draft と連関(グループ全員)を保存する", async () => {
    grant("property", "csv_export", "csv_export_personal", "owner", "sale_dm");
    (prismaMock as never as { property: { findMany: ReturnType<typeof vi.fn> } }).property.findMany.mockResolvedValue([propWithIds]);
    txPropertyOwnerFindMany.mockResolvedValue([
      { propertyId: "p1", ownerId: "o1" },
      { propertyId: "p1", ownerId: "o2" },
    ]);
    draftCreate.mockResolvedValue({ id: "d1" });
    const res = await POST(req(validBody) as never);
    expect(res.status).toBe(200);
    expect(draftCreate).toHaveBeenCalledTimes(1);
    const links = draftOwnerCreateMany.mock.calls[0][0].data;
    expect(links.map((l: { ownerId: string }) => l.ownerId).sort()).toEqual(["o1", "o2"]);
    expect(links[0].draftId).toBe("d1");
  });

  it("全宛先がリンク切れなら 409(空キャンペーンを ready にしない=#364 R2)", async () => {
    grant("property", "csv_export", "csv_export_personal", "owner", "sale_dm");
    (prismaMock as never as { property: { findMany: ReturnType<typeof vi.fn> } }).property.findMany.mockResolvedValue([propWithIds]);
    txPropertyOwnerFindMany.mockResolvedValue([
      { propertyId: "p1", ownerId: "o1" }, // o2 のリンクが外れた=このグループは保存不能
    ]);
    const res = await POST(req(validBody) as never);
    expect(res.status).toBe(409);
    expect(draftCreate).not.toHaveBeenCalled();
    expect(draftOwnerCreateMany).not.toHaveBeenCalled();
  });

  it("一部だけリンク切れなら 200+saved/skippedByUnlink を正しく報告する(#364 R2)", async () => {
    grant("property", "csv_export", "csv_export_personal", "owner", "sale_dm");
    const p2 = {
      ...propWithIds,
      id: "p2",
      propertyOwners: [
        { isPrimary: true, relationship: null, owner: { id: "o3", name: "別宅 三郎", nameKana: null, zip: "2000002", address: "神奈川県Y", corporateNumber: null } },
      ],
    };
    (prismaMock as never as { property: { findMany: ReturnType<typeof vi.fn> } }).property.findMany.mockResolvedValue([propWithIds, p2]);
    txPropertyOwnerFindMany.mockResolvedValue([
      { propertyId: "p1", ownerId: "o1" }, // o2 が外れた=p1 はスキップ
      { propertyId: "p2", ownerId: "o3" }, // p2 は健在
    ]);
    draftCreate.mockResolvedValue({ id: "d2" });
    const res = await POST(req(validBody) as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.saved).toBe(1);
    expect(json.skippedByUnlink).toBe(1);
    expect(draftCreate).toHaveBeenCalledTimes(1);
  });
});
