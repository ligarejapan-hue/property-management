import { describe, it, expect, vi, beforeEach } from "vitest";
import ExcelJS from "exceljs";
vi.mock("next/server", async () => (await import("./route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./route-mocks")).apiHelpersMock());
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn(async () => undefined) }));
vi.mock("@/lib/sales-sheet/output", () => ({
  isChromiumAvailable: vi.fn(() => true),
  renderHtmlToPdfDocument: vi.fn(async () => Buffer.from("%PDF-1.7 test")),
}));
vi.mock("@/lib/storage", () => {
  const files = new Map<string, Buffer>();
  return {
    __files: files,
    getStorage: () => ({
      upload: vi.fn(async (b: Buffer, o: { key: string }) => { files.set(o.key, b); return { url: `/uploads/${o.key}`, key: o.key }; }),
      delete: vi.fn(async (k: string) => { files.delete(k); }),
      read: vi.fn(async (k: string) => (files.has(k) ? { body: files.get(k)!, contentType: "x", size: files.get(k)!.length } : null)),
    }),
  };
});
vi.mock("@/lib/prisma", () => ({
  default: {
    deal: { findUnique: vi.fn() },
    dealDocument: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    dealRateTable: { findMany: vi.fn(async () => []) },
    dealSettings: { findUnique: vi.fn(async () => null) },
    companyProfile: { findUnique: vi.fn(async () => ({ nameJa: "架空不動産株式会社" })) },
    user: { findMany: vi.fn(async () => []) },
    property: { findUnique: vi.fn(async () => ({ createdBy: "66666666-6666-4666-8666-666666666666", assignedTo: null })) },
  },
}));

const { loadDealRegistryRights } = vi.hoisted(() => ({ loadDealRegistryRights: vi.fn(async () => ({ status: "none" })) }));
vi.mock("@/lib/deals/registry-rights-load", () => ({ loadDealRegistryRights }));

import prismaMock from "@/lib/prisma";
import * as storageMod from "@/lib/storage";
import { getApiSession, getUserPermissions, ApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { isChromiumAvailable, renderHtmlToPdfDocument } from "@/lib/sales-sheet/output";
import { jsonRequest as json, DEAL_ID, DEAL_PERMS, USER_ID } from "./route-mocks";
import { GET, POST } from "../../../app/api/deals/[id]/documents/route";
import { GET as FILE } from "../../../app/api/deals/[id]/documents/[docId]/file/route";
import { GET as AVAILABLE } from "../../../app/api/deals/[id]/documents/available/route";
import { INITIAL_RATE_TABLES } from "../rate-tables";
import { DEFAULT_FUNDING_INPUTS } from "../funding-schema";
import { DEFAULT_BUSINESS_INPUTS } from "../business-schema";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  deal: { findUnique: Fn };
  dealDocument: { findFirst: Fn; findMany: Fn; create: Fn };
  dealRateTable: { findMany: Fn };
  user: { findMany: Fn };
};
const files = (storageMod as unknown as { __files: Map<string, Buffer> }).__files;
const ctx = { params: Promise.resolve({ id: DEAL_ID }) };
const DOC_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_DEAL = "55555555-5555-4555-8555-555555555555";
const fileCtx = (id = DEAL_ID, docId = DOC_ID) => ({ params: Promise.resolve({ id, docId }) });
const get = (format?: string) => new Request(`http://x/api/file${format ? `?format=${format}` : ""}`);

const funding = { ...DEFAULT_FUNDING_INPUTS, customerName: "架空 太郎", purchase: { ...DEFAULT_FUNDING_INPUTS.purchase, loanAmount: 40_000_000 } };
const row = {
  id: DEAL_ID, dealNo: "2026-0007", name: "試験", businessType: "brokerage", tradeSide: "both", status: "considering",
  assigneeId: null, licensedAgentId: null, salesStaffId: null, opsStaffId: null, propertyId: null, propertyKind: "unit", hasOc: false,
  contractAt: new Date("2026-05-01T01:00:00Z"), contractPlace: null, settlementAt: null, settlementPlace: null,
  price: BigInt(30_000_000), buildingTax: null, deposit: null, taxRateBp: 1000,
  propertySnapshot: { buildingName: "試験マンション", address: "架空県架空市1-2-3" }, counterpartyBroker: {}, assessments: {}, costs: {}, settlementTerms: {},
  leases: [], overrides: {}, planInputs: { funding }, version: 3, createdAt: new Date(), updatedAt: new Date(), parties: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  files.clear();
  (getApiSession as Fn).mockResolvedValue({ id: USER_ID, role: "field_staff" });
  (getUserPermissions as Fn).mockResolvedValue(DEAL_PERMS);
  (isChromiumAvailable as Fn).mockReturnValue(true);
  (renderHtmlToPdfDocument as Fn).mockResolvedValue(Buffer.from("%PDF-1.7 test"));
  pm.deal.findUnique.mockResolvedValue(row);
  pm.dealDocument.findFirst.mockResolvedValue(null);
  pm.dealDocument.create.mockImplementation(async ({ data }: { data: { version: number } }) => ({ id: DOC_ID, version: data.version }));
  pm.dealRateTable.findMany.mockResolvedValue(INITIAL_RATE_TABLES.map((t) => ({
    kind: t.kind, validFrom: new Date(`${t.validFrom}T00:00:00Z`), validTo: t.validTo ? new Date(`${t.validTo}T00:00:00Z`) : null, content: t.content,
  })));
});

describe("POST /api/deals/[id]/documents(発行)", () => {
  it("保存済みの入力で PDF と Excel を作り、deals/<取引ID>/ に置いて履歴に1行足す", async () => {
    const res = await POST(json("POST", { docType: "funding_plan", version: 3 }), ctx);
    expect(res.status).toBe(201);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ id: DOC_ID, version: 1, title: "資金計画表(購入)" });
    expect(body.fileBaseName).toMatch(/^2026-0007_資金計画表_購入_\d{8}$/);
    const keys = [...files.keys()];
    expect(keys).toHaveLength(2);
    expect(keys.every((k) => k.startsWith(`deals/${DEAL_ID}/`))).toBe(true);
    expect(keys.some((k) => k.endsWith(".pdf"))).toBe(true);
    expect(keys.some((k) => k.endsWith(".xlsx"))).toBe(true);
    // 鍵にお客様名・ファイル名を入れない。
    expect(keys.join()).not.toContain("架空");
    const data = pm.dealDocument.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ dealId: DEAL_ID, docType: "funding_plan", variant: "purchase", version: 1, issuedById: USER_ID });
    expect(data.inputSnapshot).toEqual(funding);
    expect(data.calcSnapshot.purchase.loans[0].monthly).toBe(112_914);
    expect((renderHtmlToPdfDocument as Fn).mock.calls[0][0]).toContain("架空 太郎");
  });

  it("送られた入力は使わない(体には書類の種類だけ・ほかの鍵は 422)", async () => {
    const res = await POST(json("POST", { docType: "funding_plan", version: 3, fundingPlan: { ...funding, customerName: "別人" } }), ctx);
    expect(res.status).toBe(422);
    expect((await POST(json("POST", { docType: "unknown", version: 3 }), ctx)).status).toBe(422);
    expect(files.size).toBe(0);
  });

  it("監査には書類の種類・版だけ(お客様名・住所・金額は残さない)", async () => {
    await POST(json("POST", { docType: "funding_plan", version: 3 }), ctx);
    const a = (writeAuditLog as Fn).mock.calls[0][0];
    expect(a).toMatchObject({ action: "deal_document_issue", targetTable: "deals", targetId: DEAL_ID });
    expect(a.detail).toEqual({ docType: "funding_plan", variant: "purchase", version: 1, formats: ["pdf", "xlsx"] });
    expect(JSON.stringify(a)).not.toMatch(/架空|30000000|40000000/);
  });

  it("版の番号は前の版の次・同時に発行してぶつかったらやり直す", async () => {
    pm.dealDocument.findFirst.mockResolvedValueOnce({ version: 2 }).mockResolvedValueOnce({ version: 3 });
    pm.dealDocument.create
      .mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }))
      .mockImplementationOnce(async ({ data }: { data: { version: number } }) => ({ id: DOC_ID, version: data.version }));
    const res = await POST(json("POST", { docType: "funding_plan", version: 3 }), ctx);
    expect(res.status).toBe(201);
    expect((await res.json()).version).toBe(4);
    expect(pm.dealDocument.findFirst.mock.calls[0][0].where).toEqual({ dealId: DEAL_ID, docType: "funding_plan", variant: "purchase" });
  });

  it("ぶつかり続けたら 409 で、置いたファイルは消す", async () => {
    pm.dealDocument.create.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    const res = await POST(json("POST", { docType: "funding_plan", version: 3 }), ctx);
    expect(res.status).toBe(409);
    expect(files.size).toBe(0);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("記録に失敗したら置いたファイルを消す(500)", async () => {
    pm.dealDocument.create.mockRejectedValue(new Error("db down"));
    expect((await POST(json("POST", { docType: "funding_plan", version: 3 }), ctx)).status).toBe(500);
    expect(files.size).toBe(0);
  });

  it("PDF の仕組みが無い・混雑 → 503 で、ファイルも記録も残らない", async () => {
    (isChromiumAvailable as Fn).mockReturnValue(false);
    expect((await POST(json("POST", { docType: "funding_plan", version: 3 }), ctx)).status).toBe(503);
    (isChromiumAvailable as Fn).mockReturnValue(true);
    (renderHtmlToPdfDocument as Fn).mockRejectedValue(new ApiError(503, "混雑", "RENDER_BUSY"));
    expect((await POST(json("POST", { docType: "funding_plan", version: 3 }), ctx)).status).toBe(503);
    expect(files.size).toBe(0);
    expect(pm.dealDocument.create).not.toHaveBeenCalled();
  });

  it("保存のあとにほかの人が保存していたら(版の番号が違う)、発行せず 409", async () => {
    const res = await POST(json("POST", { docType: "funding_plan", version: 2 }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("VERSION_CONFLICT");
    expect(renderHtmlToPdfDocument).not.toHaveBeenCalled();
    expect(files.size).toBe(0);
    expect(pm.dealDocument.create).not.toHaveBeenCalled();
    // 版の番号が無ければ 422(どの保存を発行するのかが分からない)。
    expect((await POST(json("POST", { docType: "funding_plan" }), ctx)).status).toBe(422);
  });

  it("取引の設定のロゴと文面を PDF に入れる(ロゴは data: の URL で埋め込む)", async () => {
    files.set("deal-settings/logo-a.png", Buffer.from("ab"));
    (prismaMock as never as { dealSettings: { findUnique: Fn } }).dealSettings.findUnique.mockResolvedValue({
      representativeTitle: null, representativeName: null, bankAccount: {}, propertyKinds: [], version: 1, updatedAt: new Date(),
      logoKey: "deal-settings/logo-a.png", sealKey: null, texts: { funding_plan: { greeting: "いつもお世話になっております", notes: "概算です" } },
    });
    expect((await POST(json("POST", { docType: "funding_plan", version: 3 }), ctx)).status).toBe(201);
    const h = (renderHtmlToPdfDocument as Fn).mock.calls[0][0] as string;
    expect(h).toContain('src="data:image/png;base64,YWI="');
    expect(h).toContain("いつもお世話になっております");
    expect(h).toContain("概算です");
    (prismaMock as never as { dealSettings: { findUnique: Fn } }).dealSettings.findUnique.mockResolvedValue(null);
  });

  it("事業計画書: 買取再販の保存済みの入力で発行・社内用/銀行向けの版として残す", async () => {
    const business = { ...DEFAULT_BUSINESS_INPUTS, salePrice: 40_000_000, memo: "架空の社内メモ" };
    pm.deal.findUnique.mockResolvedValue({ ...row, businessType: "resale", tradeSide: null, planInputs: { business } });
    const res = await POST(json("POST", { docType: "business_plan", version: 3 }), ctx);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.title).toBe("事業計画書(社内用)");
    expect(body.fileBaseName).toMatch(/^2026-0007_事業計画書_社内用_\d{8}$/);
    const data = pm.dealDocument.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ docType: "business_plan", variant: "internal" });
    expect(data.inputSnapshot).toEqual(business);
    expect(data.calcSnapshot.profit.revenue).toBe(40_000_000);
    expect((renderHtmlToPdfDocument as Fn).mock.calls[0][0]).toContain("架空の社内メモ");
    expect([...files.keys()].some((k) => k.endsWith(".xlsx"))).toBe(true);

    pm.dealDocument.create.mockClear();
    (renderHtmlToPdfDocument as Fn).mockClear();
    pm.deal.findUnique.mockResolvedValue({ ...row, businessType: "resale", tradeSide: null, planInputs: { business: { ...business, variant: "bank" } } });
    expect((await (await POST(json("POST", { docType: "business_plan", version: 3 }), ctx)).json()).title).toBe("事業計画書(銀行向け)");
    expect(pm.dealDocument.create.mock.calls[0][0].data.variant).toBe("bank");
    expect((renderHtmlToPdfDocument as Fn).mock.calls[0][0]).not.toContain("架空の社内メモ");
  });

  it("事業計画書: 仲介の取引では 422 で、ファイルも記録も作らない", async () => {
    const res = await POST(json("POST", { docType: "business_plan", version: 3 }), ctx);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("NOT_RESALE");
    expect(files.size).toBe(0);
    expect(pm.dealDocument.create).not.toHaveBeenCalled();
    expect(renderHtmlToPdfDocument).not.toHaveBeenCalled();
  });

  it("売却の入力なら売却の版として残す", async () => {
    pm.deal.findUnique.mockResolvedValue({ ...row, planInputs: { funding: { ...funding, mode: "sale" } } });
    const body = await (await POST(json("POST", { docType: "funding_plan", version: 3 }), ctx)).json();
    expect(body.title).toBe("資金計画表(売却)");
    expect(pm.dealDocument.create.mock.calls[0][0].data.variant).toBe("sale");
  });

  it("書く権限が無ければ 403・取引が無ければ 404", async () => {
    pm.deal.findUnique.mockResolvedValue(null);
    expect((await POST(json("POST", { docType: "funding_plan", version: 3 }), ctx)).status).toBe(404);
    (getUserPermissions as Fn).mockResolvedValue([{ resource: "deal", action: "read", granted: true }]);
    expect((await POST(json("POST", { docType: "funding_plan", version: 3 }), ctx)).status).toBe(403);
  });
});

describe("業務書類の発行(段5a)", () => {
  const SELLER = { id: "33333333-3333-4333-8333-000000000001", role: "seller", partyType: "individual", name: "架空 一郎", representative: null, address: "架空県架空市1-1", phone: null, shareNum: null, shareDen: null, isSelf: false, sortOrder: 0, version: 1 };
  const BUYER = { ...SELLER, id: "33333333-3333-4333-8333-000000000002", role: "buyer", name: "架空 花子", address: null };
  const settled = {
    ...row, deposit: BigInt(1_500_000), settlementAt: new Date("2026-06-30T01:00:00Z"), settlementPlace: "架空銀行",
    settlementTerms: { fixedAssetTax: 100_000, cityPlanningTax: 20_000, taxStart: "01-01" }, parties: [SELLER, BUYER],
  };
  beforeEach(() => pm.deal.findUnique.mockResolvedValue(settled));

  it("領収書: 選んだもので組み立て、入力の写しに残す・監査に名前は無い・ファイル名は書類名だけ", async () => {
    const res = await POST(json("POST", { docType: "deposit_receipt", version: 3, options: { issuer: SELLER.id, exempt: "no", receivedOn: "2026-05-01" } }), ctx);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.title).toBe("手付金領収書");
    expect(body.fileBaseName).toMatch(/^2026-0007_手付金領収書_\d{8}$/);
    const data = pm.dealDocument.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ docType: "deposit_receipt", variant: "default" });
    expect(data.inputSnapshot).toEqual({ options: { issuer: SELLER.id, exempt: "no", receivedOn: "2026-05-01" } });
    expect((renderHtmlToPdfDocument as Fn).mock.calls[0][0]).toContain("金 1,500,000 円也");
    expect(JSON.stringify((writeAuditLog as Fn).mock.calls[0][0])).not.toContain("架空");
    // 個人の売主が発行した領収書の Excel にも、自社の名前を入れない(最終レビュー)
    const xlsxKey = [...files.keys()].find((k) => k.endsWith(".xlsx"))!;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(files.get(xlsxKey) as unknown as ArrayBuffer);
    const cells: unknown[] = [];
    wb.worksheets[0].eachRow((r) => r.eachCell((c) => cells.push(c.value)));
    expect(JSON.stringify(cells)).not.toContain("架空不動産株式会社");
    expect(cells).toContain("架空 一郎");
  });
  it("個人の発行者で非課税を選ばない・受け取る側でない発行者・形の違う選択 → 422 で何も作らない", async () => {
    for (const options of [
      { issuer: SELLER.id, exempt: null, receivedOn: null },
      { issuer: BUYER.id, exempt: "no", receivedOn: null },
      { issuer: SELLER.id, exempt: "maybe", receivedOn: null },
      { issuer: SELLER.id, exempt: "no", receivedOn: null, extra: 1 },
    ]) {
      expect((await POST(json("POST", { docType: "deposit_receipt", version: 3, options }), ctx)).status, JSON.stringify(options)).toBe(422);
    }
    const r = await POST(json("POST", { docType: "deposit_receipt", version: 3, options: { issuer: SELLER.id, exempt: null, receivedOn: null } }), ctx);
    expect((await r.json()).error.code).toBe("NEEDS_DECISION");
    expect(files.size).toBe(0);
    expect(pm.dealDocument.create).not.toHaveBeenCalled();
  });
  it("この取引で出せない書類(差引 0 の精算金領収書)は 422", async () => {
    pm.deal.findUnique.mockResolvedValue({ ...settled, settlementTerms: {} });
    const res = await POST(json("POST", { docType: "settlement_receipt", version: 3, options: { issuer: "self", exempt: null, receivedOn: null } }), ctx);
    expect((await res.json()).error.code).toBe("DOC_NOT_APPLICABLE");
  });
  it("精算書: 1枚に収まれば1回で作る・2ページ以上なら計算明細を2枚目に回して作り直す", async () => {
    expect((await POST(json("POST", { docType: "settlement_statement", version: 3 }), ctx)).status).toBe(201);
    expect(renderHtmlToPdfDocument).toHaveBeenCalledTimes(1);
    (renderHtmlToPdfDocument as Fn).mockClear();
    (renderHtmlToPdfDocument as Fn).mockResolvedValueOnce(Buffer.from("%PDF /Type /Pages /Type /Page /Type /Page"));
    expect((await POST(json("POST", { docType: "settlement_statement", version: 3 }), ctx)).status).toBe(201);
    expect(renderHtmlToPdfDocument).toHaveBeenCalledTimes(2);
    expect((renderHtmlToPdfDocument as Fn).mock.calls[1][0]).toContain("計算明細");
  });
  it("出せる書類と出す前の確認(空欄・初期値・選べる発行者)を返す", async () => {
    pm.deal.findUnique.mockResolvedValue({ ...settled, settlementPlace: null });
    const res = await AVAILABLE(new Request("http://x"), ctx);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body.version).toBe(3);
    const keys = body.documents.map((d: { docType: string }) => d.docType);
    // OC なしの取引には OC の4種を出さない(段5b)
    expect(keys).toEqual(["settlement_statement", "settlement_guide", "settlement_guide_seller", "deposit_receipt", "balance_receipt", "settlement_receipt", "power_of_attorney", "key_receipt", "checklist_contract", "checklist_settlement"]);
    const guide = body.documents.find((d: { docType: string }) => d.docType === "settlement_guide");
    expect(guide.missing).toEqual(["決済場所"]);
    const receipt = body.documents.find((d: { docType: string }) => d.docType === "deposit_receipt");
    expect(receipt.defaults).toEqual({ issuer: SELLER.id, exempt: null, receivedOn: null });
    expect(receipt.issuers.map((i: { value: string }) => i.value)).toEqual(["self", SELLER.id]);
    (getUserPermissions as Fn).mockResolvedValue([]);
    expect((await AVAILABLE(new Request("http://x"), ctx)).status).toBe(403);
  });
});

describe("残金決済のご案内(売主様)の発行", () => {
  const SELLER = { id: "33333333-3333-4333-8333-000000000001", role: "seller", partyType: "individual", name: "架空 一郎", representative: null, address: null, phone: null, shareNum: null, shareDen: null, isSelf: false, sortOrder: 0, version: 1 };
  it("諸費用の行を写しに残し、お受取額から引く・監査に名前は無い・金額が負なら 422", async () => {
    pm.deal.findUnique.mockResolvedValue({ ...row, deposit: BigInt(3_000_000), settlementAt: new Date("2026-06-30T01:00:00Z"), parties: [SELLER] });
    const options = { costs: [{ label: "測量費", amount: 300_000 }], receiveTo: null, belongings: null };
    const res = await POST(json("POST", { docType: "settlement_guide_seller", version: 3, options }), ctx);
    expect(res.status).toBe(201);
    expect((await res.json()).title).toBe("残金決済のご案内(売主様)");
    expect(pm.dealDocument.create.mock.calls[0][0].data.inputSnapshot).toEqual({ options });
    const h = (renderHtmlToPdfDocument as Fn).mock.calls[0][0];
    expect(h).toContain("架空 一郎 様");
    expect(h).toContain("26,700,000円");
    expect(JSON.stringify((writeAuditLog as Fn).mock.calls[0][0])).not.toContain("架空");
    const bad = await POST(json("POST", { docType: "settlement_guide_seller", version: 3, options: { ...options, costs: [{ label: "x", amount: -1 }] } }), ctx);
    expect(bad.status).toBe(422);
  });
});

describe("書類確認書と謄本の登記の現況(段5c-2)", () => {
  const RIGHTS = { status: "ok", attachmentCreatedAt: "2026-10-01T00:00:00.000Z", summary: { hasKouku: true, activeRights: [{ rank: "1", purpose: "抵当権設定", amount: null, holder: "架空銀行", debtor: "架空 一郎", activeAnnotations: 0 }], cautions: [{ section: "甲区", rank: "4", purpose: "差押" }], notes: [] } };
  beforeEach(() => {
    pm.deal.findUnique.mockResolvedValue({ ...row, propertyId: "22222222-2222-4222-8222-222222222222", settlementAt: new Date("2026-06-30T01:00:00Z") });
    loadDealRegistryRights.mockImplementation((async (p: string | null) => (p ? RIGHTS : { status: "none" })) as never);
  });
  it("決済時の書類確認書は謄本を読み、抹消の項目と登記の注意を出す(名前は出さない)", async () => {
    const res = await POST(json("POST", { docType: "checklist_settlement", version: 3, options: { pay: {} } }), ctx);
    expect(res.status).toBe(201);
    expect(loadDealRegistryRights).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222");
    const h = (renderHtmlToPdfDocument as Fn).mock.calls[0][0];
    expect(h).toContain("抵当権抹消書類(金融機関)");
    expect(h).toContain("甲区 4番 差押が残っています。");
    expect(h).not.toContain("架空銀行");
  });
  it("物件を見られない人が出すときは謄本を読まない", async () => {
    (getUserPermissions as Fn).mockResolvedValue(DEAL_PERMS.filter((p) => p.resource !== "property"));
    await POST(json("POST", { docType: "checklist_settlement", version: 3, options: { pay: {} } }), ctx);
    expect(loadDealRegistryRights).toHaveBeenCalledWith(null);
    expect((renderHtmlToPdfDocument as Fn).mock.calls[0][0]).not.toContain("抵当権抹消書類");
  });
  it("ほかの書類では謄本を読まない・読み取りが壊れても書類は出す", async () => {
    await POST(json("POST", { docType: "settlement_statement", version: 3 }), ctx);
    expect(loadDealRegistryRights).not.toHaveBeenCalled();
    loadDealRegistryRights.mockRejectedValue(new Error("boom"));
    const res = await POST(json("POST", { docType: "checklist_contract", version: 3, options: { pay: {} } }), ctx);
    expect(res.status).toBe(201);
    expect((renderHtmlToPdfDocument as Fn).mock.calls.at(-1)![0]).toContain("謄本を確認してください");
  });
  it("出せる書類: 謄本を1回だけ読み、抹消費用の払い方を選べる", async () => {
    const body = await (await AVAILABLE(new Request("http://x"), ctx)).json();
    expect(loadDealRegistryRights).toHaveBeenCalledTimes(1);
    const cl = body.documents.find((d: { docType: string }) => d.docType === "checklist_settlement");
    expect(Object.keys(cl.defaults.pay)).toContain("auto_cancel_fee");
    expect(cl.missing).toContain("抹消費用");
  });
});

describe("書類確認書の発行(段5c-1)", () => {
  const SALES = "66666666-6666-4666-8666-000000000001";
  const OPS = "66666666-6666-4666-8666-000000000002";
  it("担当者の名前を引いて頭に出す・払い方は写しに残す", async () => {
    pm.deal.findUnique.mockResolvedValue({ ...row, salesStaffId: SALES, opsStaffId: OPS, settlementAt: new Date("2026-06-30T01:00:00Z") });
    pm.user.findMany.mockResolvedValue([{ id: SALES, name: "架空 営業" }, { id: OPS, name: "架空 業務" }]);
    const options = { pay: { s_bring_payment: "from_balance" } };
    const res = await POST(json("POST", { docType: "checklist_settlement", version: 3, options }), ctx);
    expect(res.status).toBe(201);
    expect((await res.json()).title).toBe("書類確認書(決済時)");
    const h = (renderHtmlToPdfDocument as Fn).mock.calls[0][0];
    expect(h).toContain("架空 営業");
    expect(h).toContain("架空 業務");
    expect(h).toContain("残金から");
    expect(pm.user.findMany.mock.calls[0][0].where.id.in.sort()).toEqual([SALES, OPS]);
    expect(pm.dealDocument.create.mock.calls[0][0].data.inputSnapshot).toEqual({ options });
  });
  it("担当が無ければユーザーを読まない・知らない払い方は 422", async () => {
    const ok = await POST(json("POST", { docType: "checklist_contract", version: 3, options: { pay: {} } }), ctx);
    expect(ok.status).toBe(201);
    expect(pm.user.findMany).not.toHaveBeenCalled();
    const bad = await POST(json("POST", { docType: "checklist_contract", version: 3, options: { pay: { c_bring_deposit: "card" } } }), ctx);
    expect(bad.status).toBe(422);
  });
  it("出せる書類に、書類確認書のまとまりと払い方の選べる値を返す", async () => {
    const body = await (await AVAILABLE(new Request("http://x"), ctx)).json();
    const cl = body.documents.find((d: { docType: string }) => d.docType === "checklist_contract");
    expect(cl.group).toBe("checklist");
    expect(cl.choices.payMethods.map((x: { value: string }) => x.value)).toEqual(["cash", "from_deposit", "from_balance"]);
    expect(cl.defaults).toEqual({ pay: { c_bring_deposit: "cash" } });
  });
});

describe("業務書類の発行(段5b)", () => {
  const SELLER = { id: "33333333-3333-4333-8333-000000000001", role: "seller", partyType: "individual", name: "架空 一郎", representative: null, address: "架空県架空市1-1", phone: null, shareNum: null, shareDen: null, isSelf: false, sortOrder: 0, version: 1 };
  const BUYER = { ...SELLER, id: "33333333-3333-4333-8333-000000000002", role: "buyer", name: "架空 花子", address: null };
  const LEASE = { room: "101", tenant: "架空 三郎", contractType: "ordinary", period: null, rent: 80000, commonFee: 0, parking: 0, other: 0, deposit: 160000, arrears: false, arrearsAmount: 0, manager: null };
  const base = { ...row, settlementAt: new Date("2026-06-30T01:00:00Z"), parties: [SELLER, BUYER] };
  const oc = { ...base, hasOc: true, leases: [LEASE, { ...LEASE, room: "102", tenant: null }, { ...LEASE, room: "201", tenant: "架空 四郎" }] };
  beforeEach(() => pm.deal.findUnique.mockResolvedValue(base));

  it("出せる書類に、まとまりと当事者から選ぶ値(委任者・受任者・鍵の受領者)を返す", async () => {
    const body = await (await AVAILABLE(new Request("http://x"), ctx)).json();
    const poa = body.documents.find((d: { docType: string }) => d.docType === "power_of_attorney");
    expect(poa.group).toBe("other");
    expect(poa.defaults).toMatchObject({ principal: SELLER.id, agent: "self", matters: [] });
    expect(poa.choices.principal.map((x: { value: string }) => x.value)).toEqual([SELLER.id, BUYER.id]);
    const key = body.documents.find((d: { docType: string }) => d.docType === "key_receipt");
    expect(key.choices.receiver.map((x: { value: string }) => x.value)).toEqual(["self", BUYER.id]);
    expect(body.documents.find((d: { docType: string }) => d.docType === "settlement_statement").group).toBe("settlement");
  });
  it("委任状: 選んだもので組み立て、写しに残す・監査に名前は無い", async () => {
    const options = { principal: SELLER.id, agent: "self", matters: ["receive_balance"], otherMatter: null, signedOn: null };
    const res = await POST(json("POST", { docType: "power_of_attorney", version: 3, options }), ctx);
    expect(res.status).toBe(201);
    expect((await res.json()).title).toBe("委任状");
    expect(pm.dealDocument.create.mock.calls[0][0].data.inputSnapshot).toEqual({ options });
    expect((renderHtmlToPdfDocument as Fn).mock.calls[0][0]).toContain("残代金の受領");
    expect(JSON.stringify((writeAuditLog as Fn).mock.calls[0][0])).not.toContain("架空");
  });
  it("委任内容が無い委任状・鍵の行が無い鍵受領書は 422 で何も作らない", async () => {
    const r1 = await POST(json("POST", { docType: "power_of_attorney", version: 3, options: { principal: SELLER.id, agent: "self", matters: [], otherMatter: null, signedOn: null } }), ctx);
    expect((await r1.json()).error.code).toBe("NO_MATTER");
    const r2 = await POST(json("POST", { docType: "key_receipt", version: 3, options: { receiver: BUYER.id, keys: [], receivedOn: null } }), ctx);
    expect((await r2.json()).error.code).toBe("NO_KEYS");
    expect(files.size).toBe(0);
    expect(pm.dealDocument.create).not.toHaveBeenCalled();
  });
  it("OC の書類: OC なしの取引では 422・OC ありならお知らせを賃借人のいる部屋ごとに作る", async () => {
    const r = await POST(json("POST", { docType: "landlord_change_notice", version: 3, options: { changeOn: null, payee: null } }), ctx);
    expect((await r.json()).error.code).toBe("DOC_NOT_APPLICABLE");
    pm.deal.findUnique.mockResolvedValue(oc);
    const res = await POST(json("POST", { docType: "landlord_change_notice", version: 3, options: { changeOn: "2026-06-30", payee: null } }), ctx);
    expect(res.status).toBe(201);
    const htmlOut = (renderHtmlToPdfDocument as Fn).mock.calls[0][0] as string;
    expect(htmlOut).toContain("101 架空 三郎 様");
    expect(htmlOut).toContain("201 架空 四郎 様");
    expect(htmlOut.match(/page-break-before:always/g)?.length).toBe(1);
    // 賃借人がいない(止める項目がある)ときは、画面を通さなくても 422 で何も作らない
    pm.deal.findUnique.mockResolvedValue({ ...oc, leases: [{ ...LEASE, tenant: null }] });
    (renderHtmlToPdfDocument as Fn).mockClear();
    const blocked = await POST(json("POST", { docType: "tenant_survey", version: 3 }), ctx);
    expect((await blocked.json()).error.code).toBe("DOC_BLOCKED");
    expect(renderHtmlToPdfDocument).not.toHaveBeenCalled();
    pm.deal.findUnique.mockResolvedValue(oc);
    const keys = (await (await AVAILABLE(new Request("http://x"), ctx)).json()).documents.map((d: { docType: string }) => d.docType);
    expect(keys).toEqual(expect.arrayContaining(["oc_purchase_consult", "tenant_survey", "landlord_change_notice", "handover_checklist"]));
  });
});

describe("GET /api/deals/[id]/documents(発行履歴)", () => {
  it("新しい順に、書類名・版・発行者を返す(保存場所の鍵は返さない)", async () => {
    pm.dealDocument.findMany.mockResolvedValue([{
      id: DOC_ID, docType: "funding_plan", variant: "sale", version: 2, issuedAt: new Date("2026-10-24T01:00:00Z"),
      fileBaseName: "2026-0007_資金計画表_売却_20261024", pdfKey: `deals/${DEAL_ID}/a.pdf`, xlsxKey: null, issuedBy: { name: "試験 担当" },
    }]);
    const res = await GET(new Request("http://x"), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const { documents } = await res.json();
    expect(documents[0]).toEqual({
      id: DOC_ID, docType: "funding_plan", variant: "sale", version: 2, title: "資金計画表(売却)", issuedAt: "2026-10-24T01:00:00.000Z",
      issuedByName: "試験 担当", fileBaseName: "2026-0007_資金計画表_売却_20261024", hasPdf: true, hasXlsx: false,
    });
    expect(JSON.stringify(documents)).not.toContain("deals/");
    expect(pm.dealDocument.findMany.mock.calls[0][0].where).toEqual({ dealId: DEAL_ID });
  });
  it("見る権限が無ければ 403・取引が無ければ 404", async () => {
    pm.deal.findUnique.mockResolvedValue(null);
    expect((await GET(new Request("http://x"), ctx)).status).toBe(404);
    (getUserPermissions as Fn).mockResolvedValue([]);
    expect((await GET(new Request("http://x"), ctx)).status).toBe(403);
  });
});

describe("GET /api/deals/[id]/documents/[docId]/file(ファイルを開く)", () => {
  const doc = { pdfKey: `deals/${DEAL_ID}/f.pdf`, xlsxKey: `deals/${DEAL_ID}/f.xlsx`, fileBaseName: "2026-0007_資金計画表_購入_20261024" };
  beforeEach(() => {
    files.set(doc.pdfKey, Buffer.from("%PDF-1.7 x"));
    files.set(doc.xlsxKey, Buffer.from("PK xlsx"));
    pm.dealDocument.findFirst.mockResolvedValue(doc);
  });

  it("PDF はブラウザで開く・控えを残さない・日本語のファイル名", async () => {
    const res = await FILE(get("pdf"), fileCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const cd = res.headers.get("Content-Disposition")!;
    expect(cd.startsWith("inline;")).toBe(true);
    expect(decodeURIComponent(cd.split("UTF-8''")[1])).toBe("2026-0007_資金計画表_購入_20261024.pdf");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("%PDF-1.7 x");
    // 別の取引の書類 ID を混ぜても引けないよう、取引 ID と書類 ID の両方で探す。
    expect(pm.dealDocument.findFirst.mock.calls[0][0].where).toEqual({ id: DOC_ID, dealId: DEAL_ID });
  });

  it("Excel は保存させる", async () => {
    const res = await FILE(get("xlsx"), fileCtx());
    expect(res.headers.get("Content-Type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(res.headers.get("Content-Disposition")!.startsWith("attachment;")).toBe(true);
  });

  it("取引を見る権限が無い人は 404(403 にしない)", async () => {
    (getUserPermissions as Fn).mockResolvedValue([{ resource: "deal", action: "read", granted: false }]);
    const res = await FILE(get("pdf"), fileCtx());
    expect(res.status).toBe(404);
    expect(pm.dealDocument.findFirst).not.toHaveBeenCalled();
  });

  it("別の取引・記録なし・その形式のファイルなし・実体なし・形式や ID が変 → すべて 404", async () => {
    pm.dealDocument.findFirst.mockResolvedValueOnce(null);
    expect((await FILE(get("pdf"), fileCtx(OTHER_DEAL))).status).toBe(404);
    pm.dealDocument.findFirst.mockResolvedValueOnce({ ...doc, xlsxKey: null });
    expect((await FILE(get("xlsx"), fileCtx())).status).toBe(404);
    files.clear();
    expect((await FILE(get("pdf"), fileCtx())).status).toBe(404);
    expect((await FILE(get("html"), fileCtx())).status).toBe(404);
    expect((await FILE(get("pdf"), fileCtx(DEAL_ID, "not-a-uuid"))).status).toBe(404);
  });

  it("ログインしていなければ 401 のまま", async () => {
    (getApiSession as Fn).mockRejectedValue(new ApiError(401, "未ログイン", "UNAUTHORIZED"));
    expect((await FILE(get("pdf"), fileCtx())).status).toBe(401);
  });
});
