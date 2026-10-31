import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { syncDealScheduleSafe, writeAuditLog, canOpenReferralDocument, storage } = vi.hoisted(() => ({
  syncDealScheduleSafe: vi.fn(async () => undefined),
  writeAuditLog: vi.fn(),
  canOpenReferralDocument: vi.fn(() => true),
  storage: { read: vi.fn() },
}));
vi.mock("next/server", async () => (await import("../../__tests__/route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("../../__tests__/route-mocks")).apiHelpersMock());
vi.mock("@/lib/deals/schedule-sync", async (orig) => ({ ...(await orig<typeof import("../../schedule-sync")>()), syncDealScheduleSafe }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
vi.mock("@/lib/storage", () => ({ getStorage: () => storage }));
vi.mock("@/lib/uploads-authorization", () => ({ canOpenReferralDocument }));
vi.mock("@/lib/sale-dm-letter/config-store", () => ({ loadSaleDmPublicPageConfig: vi.fn(async () => ({ trackingBaseUrl: "https://public.example" })) }));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    deal: { findUnique: vi.fn() },
    dealDocLink: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null), create: vi.fn(async () => ({ id: "l1" })), update: vi.fn(async () => ({ id: "l1" })), updateMany: vi.fn(async () => ({ count: 1 })) },
    dealDocRequest: { deleteMany: vi.fn(async () => ({ count: 0 })), createMany: vi.fn(async () => ({ count: 1 })), findFirst: vi.fn(), update: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    dealDocFile: { updateMany: vi.fn(async () => ({ count: 2 })), findFirst: vi.fn(), findMany: vi.fn(async () => []) },
    dealSettings: { findUnique: vi.fn(async () => null) },
    companyProfile: { findUnique: vi.fn(async () => null) },
    $queryRaw: vi.fn(async () => []),
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { default: db };
});

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { DEAL_ID, DEAL_PERMS, PARTY_ID, jsonRequest } from "../../__tests__/route-mocks";
import { GET, POST as ISSUE } from "@/app/api/deals/[id]/doc-links/route";
import { POST as REVOKE } from "@/app/api/deals/[id]/doc-links/[linkId]/revoke/route";
import { POST as REVIEW } from "@/app/api/deals/[id]/doc-links/requests/[requestId]/route";
import { GET as DOWNLOAD } from "@/app/api/deals/[id]/doc-links/files/[fileId]/route";
import { docLinkExpiresAt } from "../constants";
import { buildDocLinkToken, verifyDocLinkToken } from "../token";
import { loadDocProgress, loadReceivedChecklistItemIds } from "../staff-store";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  deal: { findUnique: Fn };
  dealDocLink: { findMany: Fn; findFirst: Fn; create: Fn; update: Fn; updateMany: Fn };
  dealDocRequest: { deleteMany: Fn; createMany: Fn; findFirst: Fn; update: Fn; findMany: Fn };
  dealDocFile: { updateMany: Fn; findFirst: Fn; findMany: Fn };
  $queryRaw: Fn;
};
const SECRET = "s".repeat(40);
const LINK_ID = "55555555-5555-4555-8555-555555555555";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const FILE_ID = "77777777-7777-4777-8777-777777777777";
const dealCtx = { params: Promise.resolve({ id: DEAL_ID }) };
const dealRow = (party: Record<string, unknown> = { id: PARTY_ID, role: "seller", isSelf: false }) => ({ status: "contracted", propertyKind: null, hasOc: false, parties: [party] });
const issueBody = { partyId: PARTY_ID, itemIds: ["s_bring_id", "s_recv_title"] };
const READ_ONLY = DEAL_PERMS.filter((p) => p.action === "read");

const ORIGINAL = process.env.DEAL_DOC_LINK_SECRET;
afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.DEAL_DOC_LINK_SECRET;
  else process.env.DEAL_DOC_LINK_SECRET = ORIGINAL;
});
beforeEach(() => {
  vi.clearAllMocks();
  process.env.DEAL_DOC_LINK_SECRET = SECRET;
  (getApiSession as Fn).mockResolvedValue({ id: "u-office", role: "office_staff" });
  (getUserPermissions as Fn).mockResolvedValue(DEAL_PERMS);
  canOpenReferralDocument.mockReturnValue(true);
  pm.deal.findUnique.mockResolvedValue(dealRow());
  pm.dealDocLink.findFirst.mockResolvedValue(null);
  pm.dealDocLink.findMany.mockResolvedValue([]);
  pm.dealDocLink.updateMany.mockResolvedValue({ count: 1 });
  pm.dealDocRequest.findFirst.mockResolvedValue({ status: "submitted" });
  pm.dealDocFile.findMany.mockResolvedValue([{ id: FILE_ID }]);
});

describe("発行", () => {
  it("14日の期限で作る。トークンは保存も返しもしない", async () => {
    const res = await ISSUE(jsonRequest("POST", issueBody), dealCtx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const data = pm.dealDocLink.create.mock.calls[0][0].data;
    expect(data.publicId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(data).not.toHaveProperty("token");
    expect(data.expiresAt).toEqual(docLinkExpiresAt(new Date(), 14));
    expect(pm.dealDocRequest.createMany.mock.calls[0][0].data.map((d: { label: string }) => d.label)).toEqual(["本人確認書類", "登記識別情報(権利証)・登記に必要な書類"]);
  });
  it("監査は事実・取引・件数だけ", async () => {
    await ISSUE(jsonRequest("POST", issueBody), dealCtx);
    expect(writeAuditLog).toHaveBeenCalledWith({ userId: "u-office", action: "deal_doc_link_issue", targetTable: "deals", targetId: DEAL_ID, detail: { count: 2 } });
  });
  it("売主のリンクで段取りを完了候補に。買主では動かさない", async () => {
    await ISSUE(jsonRequest("POST", issueBody), dealCtx);
    expect(syncDealScheduleSafe).toHaveBeenCalledWith(DEAL_ID, expect.objectContaining({ event: { docLinkIssued: true } }));
    syncDealScheduleSafe.mockClear();
    pm.deal.findUnique.mockResolvedValue(dealRow({ id: PARTY_ID, role: "buyer", isSelf: false }));
    await ISSUE(jsonRequest("POST", issueBody), dealCtx);
    expect(syncDealScheduleSafe).not.toHaveBeenCalled();
  });
  it("金額付き・謄本から足す項目・準備の項目は選べない", async () => {
    for (const bad of ["s_bring_payment", "auto_cancel_docs", "s_scrivener", "c_bring_id"]) {
      const res = await ISSUE(jsonRequest("POST", { partyId: PARTY_ID, itemIds: [bad] }), dealCtx);
      expect(res.status, bad).toBe(422);
    }
    expect(pm.dealDocLink.create).not.toHaveBeenCalled();
  });
  it("自社・売主買主でない当事者には発行できない", async () => {
    pm.deal.findUnique.mockResolvedValue(dealRow({ id: PARTY_ID, role: "seller", isSelf: true }));
    expect((await ISSUE(jsonRequest("POST", issueBody), dealCtx)).status).toBe(422);
    pm.deal.findUnique.mockResolvedValue(dealRow({ id: PARTY_ID, role: "agent", isSelf: false }));
    expect((await ISSUE(jsonRequest("POST", issueBody), dealCtx)).status).toBe(422);
    pm.deal.findUnique.mockResolvedValue({ ...dealRow(), parties: [] });
    expect((await ISSUE(jsonRequest("POST", issueBody), dealCtx)).status).toBe(422);
  });
  it("中止・決済済の取引には発行できない", async () => {
    pm.deal.findUnique.mockResolvedValue({ ...dealRow(), status: "cancelled" });
    expect((await ISSUE(jsonRequest("POST", issueBody), dealCtx)).status).toBe(422);
  });
  it("鍵が無ければ発行できない", async () => {
    delete process.env.DEAL_DOC_LINK_SECRET;
    const res = await ISSUE(jsonRequest("POST", issueBody), dealCtx);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("DOC_LINK_NOT_CONFIGURED");
  });
  it("取引の編集権限がなければ発行できない", async () => {
    (getUserPermissions as Fn).mockResolvedValue(READ_ONLY);
    expect((await ISSUE(jsonRequest("POST", issueBody), dealCtx)).status).toBe(403);
  });
  it("発行し直しは同じ URL のまま。作り直しと、無効にしたリンクだけ URL を変える", async () => {
    pm.dealDocLink.findFirst.mockResolvedValue({ id: "l1", revokedAt: null });
    await ISSUE(jsonRequest("POST", issueBody), dealCtx);
    expect(pm.dealDocLink.update.mock.calls[0][0].data).not.toHaveProperty("publicId");
    await ISSUE(jsonRequest("POST", { ...issueBody, rotate: true }), dealCtx);
    expect(pm.dealDocLink.update.mock.calls[1][0].data.publicId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    pm.dealDocLink.findFirst.mockResolvedValue({ id: "l1", revokedAt: new Date() });
    await ISSUE(jsonRequest("POST", issueBody), dealCtx);
    expect(pm.dealDocLink.update.mock.calls[2][0].data).toMatchObject({ revokedAt: null, publicId: expect.any(String) });
  });
  it("外した書類は、何も届いていないものだけ消す", async () => {
    await ISSUE(jsonRequest("POST", issueBody), dealCtx);
    expect(pm.dealDocRequest.deleteMany.mock.calls[0][0].where).toMatchObject({ status: "pending", checklistItemId: { notIn: issueBody.itemIds } });
  });
});

describe("提出状況の一覧", () => {
  const link = {
    id: LINK_ID, partyId: PARTY_ID, partyRole: "seller", publicId: "A".repeat(22), expiresAt: new Date(Date.now() + 86_400_000), revokedAt: null, party: { name: "試験 太郎", role: "seller", isSelf: false },
    requests: [{ id: REQUEST_ID, checklistItemId: "s_bring_id", label: "本人確認書類", status: "submitted", rejectReason: null, files: [{ id: FILE_ID, mimeType: "image/jpeg", fileSize: 10, reviewState: "unreviewed", createdAt: new Date() }] }],
  };
  beforeEach(() => {
    pm.dealDocLink.findMany.mockResolvedValue([link]);
    pm.deal.findUnique.mockResolvedValue({ ...dealRow(), parties: [{ id: PARTY_ID, role: "seller", name: "試験 太郎", isSelf: false }, { id: "self", role: "buyer", name: "自社", isSelf: true }] });
  });
  it("編集権限と中身の権限があれば URL とファイルを返す", async () => {
    const body = await (await GET(new Request("http://x"), dealCtx)).json();
    const url: string = body.links[0].url;
    expect(url.startsWith("https://public.example/submit/")).toBe(true);
    expect(verifyDocLinkToken(url.split("/").pop() as string, Buffer.from(SECRET))).toBe("A".repeat(22));
    expect(body.links[0].guidance).toContain(url);
    expect(body.links[0].requests[0].files[0].id).toBe(FILE_ID);
    expect(body.parties.map((p: { name: string }) => p.name)).toEqual(["試験 太郎"]);
    expect(body.available).toBe(true);
  });
  it("編集権限がなければ差し戻しの理由を返さない", async () => {
    pm.dealDocLink.findMany.mockResolvedValue([{ ...link, requests: [{ ...link.requests[0], status: "rejected", rejectReason: "試験 太郎さんの文字が読めません" }] }]);
    expect(JSON.stringify(await (await GET(new Request("http://x"), dealCtx)).json())).toContain("文字が読めません");
    (getUserPermissions as Fn).mockResolvedValue(READ_ONLY);
    const body = await (await GET(new Request("http://x"), dealCtx)).json();
    expect(JSON.stringify(body)).not.toContain("文字が読めません");
    expect(body.links[0].requests[0].status).toBe("rejected");
  });
  it("売主を買主に変えたリンクは URL を出さない", async () => {
    pm.dealDocLink.findMany.mockResolvedValue([{ ...link, party: { name: "試験 太郎", role: "buyer", isSelf: false } }]);
    const body = await (await GET(new Request("http://x"), dealCtx)).json();
    expect(body.links[0].state).toBe("party_changed");
    expect(body.links[0].url).toBeNull();
  });
  it("編集権限がなければ URL を返さない", async () => {
    (getUserPermissions as Fn).mockResolvedValue(READ_ONLY);
    const text = JSON.stringify(await (await GET(new Request("http://x"), dealCtx)).json());
    expect(text).not.toContain("/submit/");
    expect(text).not.toContain(buildDocLinkToken("A".repeat(22), Buffer.from(SECRET)));
    expect(text).not.toContain(FILE_ID);
    expect(text).toContain('"fileCount":1');
  });
  it("中身の権限がなければファイルの一覧を返さない", async () => {
    canOpenReferralDocument.mockReturnValue(false);
    const body = await (await GET(new Request("http://x"), dealCtx)).json();
    expect(body.canReview).toBe(false);
    expect(body.links[0].requests[0].files).toEqual([]);
    expect(body.links[0].url).toBeTruthy();
  });
  it("無効にしたリンクは URL を出さない", async () => {
    pm.dealDocLink.findMany.mockResolvedValue([{ ...link, revokedAt: new Date() }]);
    const body = await (await GET(new Request("http://x"), dealCtx)).json();
    expect(body.links[0].state).toBe("revoked");
    expect(body.links[0].url).toBeNull();
    expect(body.links[0].guidance).toBeNull();
  });
  it("発行できる項目は決済時の持参・受け取りだけ", async () => {
    const body = await (await GET(new Request("http://x"), dealCtx)).json();
    const ids = body.options.map((o: { id: string }) => o.id);
    expect(ids).toContain("s_bring_id");
    expect(ids).toContain("s_recv_title");
    for (const no of ["s_bring_payment", "s_scrivener", "c_bring_id", "auto_cancel_docs"]) expect(ids).not.toContain(no);
  });
});

describe("無効化", () => {
  const ctx = { params: Promise.resolve({ id: DEAL_ID, linkId: LINK_ID }) };
  it("無効にして、事実だけ監査に残す", async () => {
    const res = await REVOKE(new Request("http://x", { method: "POST" }), ctx);
    expect(res.status).toBe(200);
    expect(pm.dealDocLink.updateMany).toHaveBeenCalledWith({ where: { id: LINK_ID, dealId: DEAL_ID, revokedAt: null }, data: { revokedAt: expect.any(Date) } });
    // 提出と同じ取引の行を押さえてから書く。
    expect(pm.$queryRaw).toHaveBeenCalled();
    expect(pm.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(pm.dealDocLink.updateMany.mock.invocationCallOrder[0]);
    expect(writeAuditLog).toHaveBeenCalledWith({ userId: "u-office", action: "deal_doc_link_revoke", targetTable: "deals", targetId: DEAL_ID, detail: { count: 1 } });
  });
  it("別の取引のリンクや無効済みは 404", async () => {
    pm.dealDocLink.updateMany.mockResolvedValue({ count: 0 });
    expect((await REVOKE(new Request("http://x", { method: "POST" }), ctx)).status).toBe(404);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});

describe("受領・差し戻し", () => {
  const ctx = { params: Promise.resolve({ id: DEAL_ID, requestId: REQUEST_ID }) };
  it("受領するとファイルの状態も受領にする", async () => {
    const res = await REVIEW(jsonRequest("POST", { action: "receive", fileIds: [FILE_ID] }), ctx);
    expect(res.status).toBe(200);
    expect(pm.dealDocRequest.update.mock.calls[0][0].data).toMatchObject({ status: "received", rejectReason: null, reviewedById: "u-office" });
    expect(pm.dealDocFile.updateMany.mock.calls[0][0]).toMatchObject({
      where: { requestId: REQUEST_ID, reviewState: { in: ["unreviewed", "deal_cancelled_unreviewed"] } },
      data: { reviewState: "received" },
    });
    expect(writeAuditLog).toHaveBeenCalledWith({ userId: "u-office", action: "deal_doc_receive", targetTable: "deals", targetId: DEAL_ID, detail: { count: 2 } });
  });
  it("差し戻しは理由が要る。理由は監査に入れない", async () => {
    expect((await REVIEW(jsonRequest("POST", { action: "reject", fileIds: [FILE_ID], reason: "  " }), ctx)).status).toBe(422);
    expect((await REVIEW(jsonRequest("POST", { action: "reject", fileIds: [FILE_ID] }), ctx)).status).toBe(422);
    const res = await REVIEW(jsonRequest("POST", { action: "reject", fileIds: [FILE_ID], reason: "試験 太郎さんの文字が読めません" }), ctx);
    expect(res.status).toBe(200);
    expect(pm.dealDocRequest.update.mock.calls[0][0].data).toMatchObject({ status: "rejected", rejectReason: "試験 太郎さんの文字が読めません" });
    expect(pm.dealDocFile.updateMany.mock.calls[0][0].data).toMatchObject({ reviewState: "rejected" });
    expect(writeAuditLog).toHaveBeenCalledWith({ userId: "u-office", action: "deal_doc_reject", targetTable: "deals", targetId: DEAL_ID, detail: { count: 2 } });
    expect(JSON.stringify(writeAuditLog.mock.calls)).not.toContain("試験 太郎");
  });
  it("中身の権限がなければ 403", async () => {
    canOpenReferralDocument.mockReturnValue(false);
    expect((await REVIEW(jsonRequest("POST", { action: "receive", fileIds: [FILE_ID] }), ctx)).status).toBe(403);
    expect(pm.dealDocRequest.update).not.toHaveBeenCalled();
  });
  it("確認待ちでなければ 409(二重に押しても動かない)", async () => {
    pm.dealDocRequest.findFirst.mockResolvedValue({ status: "received" });
    expect((await REVIEW(jsonRequest("POST", { action: "receive", fileIds: [FILE_ID] }), ctx)).status).toBe(409);
    expect(pm.dealDocFile.updateMany).not.toHaveBeenCalled();
  });
  it("画面に出ていたファイルの組と違えば 409(見ていないファイルを受領にしない)", async () => {
    const NEW_FILE = "88888888-8888-4888-8888-888888888888";
    // 見たあとにお客様が1つ足した
    pm.dealDocFile.findMany.mockResolvedValue([{ id: FILE_ID }, { id: NEW_FILE }]);
    const res = await REVIEW(jsonRequest("POST", { action: "receive", fileIds: [FILE_ID] }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("FILES_CHANGED");
    expect(pm.dealDocRequest.update).not.toHaveBeenCalled();
    expect(pm.dealDocFile.updateMany).not.toHaveBeenCalled();
    // 差し戻しのあとで出し直された(同じ確認待ちでもファイルが違う)
    pm.dealDocFile.findMany.mockResolvedValue([{ id: NEW_FILE }]);
    expect((await REVIEW(jsonRequest("POST", { action: "reject", fileIds: [FILE_ID], reason: "x" }), ctx)).status).toBe(409);
    expect(pm.dealDocRequest.update).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
  it("ファイルの組を送らなければ 422", async () => {
    expect((await REVIEW(jsonRequest("POST", { action: "receive" }), ctx)).status).toBe(422);
    expect((await REVIEW(jsonRequest("POST", { action: "receive", fileIds: [] }), ctx)).status).toBe(422);
  });
  it("別の取引の書類は 404", async () => {
    pm.dealDocRequest.findFirst.mockResolvedValue(null);
    expect((await REVIEW(jsonRequest("POST", { action: "receive", fileIds: [FILE_ID] }), ctx)).status).toBe(404);
    expect(pm.dealDocRequest.findFirst.mock.calls[0][0].where).toEqual({ id: REQUEST_ID, link: { dealId: DEAL_ID } });
  });
});

describe("ダウンロード", () => {
  const ctx = { params: Promise.resolve({ id: DEAL_ID, fileId: FILE_ID }) };
  beforeEach(() => {
    pm.dealDocFile.findFirst.mockResolvedValue({ storageKey: `deals/${DEAL_ID}/submissions/x.pdf`, mimeType: "application/pdf", request: { label: "本人確認書類" } });
    storage.read.mockResolvedValue({ body: Buffer.from("%PDF-1.7") });
  });
  it("必ずダウンロードで渡す(ブラウザの中で開かない)", async () => {
    const res = await DOWNLOAD(new Request("http://x"), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(pm.dealDocFile.findFirst.mock.calls[0][0].where).toEqual({ id: FILE_ID, request: { link: { dealId: DEAL_ID } } });
  });
  it("権限がなければ 404(あるかどうかを教えない)", async () => {
    canOpenReferralDocument.mockReturnValue(false);
    expect((await DOWNLOAD(new Request("http://x"), ctx)).status).toBe(404);
    (getUserPermissions as Fn).mockResolvedValue(READ_ONLY);
    canOpenReferralDocument.mockReturnValue(true);
    expect((await DOWNLOAD(new Request("http://x"), ctx)).status).toBe(404);
    expect(storage.read).not.toHaveBeenCalled();
  });
  it("無いファイルは 404", async () => {
    pm.dealDocFile.findFirst.mockResolvedValue(null);
    expect((await DOWNLOAD(new Request("http://x"), ctx)).status).toBe(404);
  });
});

describe("段取りと書類確認書へのつなぎ", () => {
  it("受領の進み具合", async () => {
    pm.dealDocLink.findMany.mockResolvedValue([
      { partyRole: "seller", party: { name: "試験 太郎" }, requests: [{ status: "received" }, { status: "submitted" }] },
      { partyRole: "buyer", party: { name: "試験 花子" }, requests: [] },
    ]);
    expect(await loadDocProgress(DEAL_ID)).toEqual([{ partyRole: "seller", partyName: "試験 太郎", total: 2, received: 1 }]);
    expect(pm.dealDocLink.findMany.mock.calls[0][0].where).toEqual({ dealId: DEAL_ID, partyId: { not: null } });
  });
  it("書類確認書の ✓ に使う項目", async () => {
    pm.dealDocRequest.findMany.mockResolvedValue([{ checklistItemId: "a", status: "received" }, { checklistItemId: "b", status: "pending" }]);
    expect([...(await loadReceivedChecklistItemIds(DEAL_ID))]).toEqual(["a"]);
  });
});
