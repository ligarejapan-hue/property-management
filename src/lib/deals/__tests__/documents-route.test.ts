import { describe, it, expect, vi, beforeEach } from "vitest";
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
  },
}));

import prismaMock from "@/lib/prisma";
import * as storageMod from "@/lib/storage";
import { getApiSession, getUserPermissions, ApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { isChromiumAvailable, renderHtmlToPdfDocument } from "@/lib/sales-sheet/output";
import { jsonRequest as json, DEAL_ID, DEAL_PERMS, USER_ID } from "./route-mocks";
import { GET, POST } from "../../../app/api/deals/[id]/documents/route";
import { GET as FILE } from "../../../app/api/deals/[id]/documents/[docId]/file/route";
import { INITIAL_RATE_TABLES } from "../rate-tables";
import { DEFAULT_FUNDING_INPUTS } from "../funding-schema";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  deal: { findUnique: Fn };
  dealDocument: { findFirst: Fn; findMany: Fn; create: Fn };
  dealRateTable: { findMany: Fn };
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
