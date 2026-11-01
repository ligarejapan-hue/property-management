import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { storage, writeAuditLog } = vi.hoisted(() => ({
  storage: { upload: vi.fn(async () => ({})), delete: vi.fn(async () => undefined), read: vi.fn(), getUrl: vi.fn(), keyFromUrl: vi.fn() },
  writeAuditLog: vi.fn(),
}));
vi.mock("@/lib/storage", () => ({ getStorage: () => storage }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    dealDocLink: { findUnique: vi.fn() },
    dealDocRequest: { findMany: vi.fn(async () => []), findFirst: vi.fn(), update: vi.fn(async () => ({})) },
    dealDocFile: { count: vi.fn(async () => 0), create: vi.fn(async () => ({})) },
    companyProfile: { findUnique: vi.fn(async () => null) },
    $queryRaw: vi.fn(async () => []),
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { default: db };
});

import prismaMock from "@/lib/prisma";
import { GET } from "@/app/submit/[token]/route";
import { POST } from "@/app/submit/[token]/upload/route";
import { DOC_FILE_MAX_BYTES } from "../constants";
import { buildDocLinkToken } from "../token";
import { DIRTY_JPEG } from "./fixtures";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  dealDocLink: { findUnique: Fn };
  dealDocRequest: { findMany: Fn; findFirst: Fn; update: Fn };
  dealDocFile: { count: Fn; create: Fn };
};

const SECRET = "s".repeat(40);
const PUBLIC_ID = "A".repeat(22);
const TOKEN = buildDocLinkToken(PUBLIC_ID, Buffer.from(SECRET));
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const DEAL_ID = "11111111-1111-4111-8111-111111111111";
const FUTURE = new Date(Date.now() + 86_400_000);
const openLink = { id: "l1", dealId: DEAL_ID, partyRole: "seller", party: { role: "seller", isSelf: false }, expiresAt: FUTURE, revokedAt: null, deal: { status: "contracted" } };

let ipSeq = 0;
const nextIp = () => `10.0.${Math.floor(++ipSeq / 200)}.${ipSeq % 200}`;
const ctx = (token = TOKEN) => ({ params: Promise.resolve({ token }) });
const page = (ip = nextIp(), token = TOKEN) => GET(new Request(`http://x/submit/${token}`, { headers: { "x-real-ip": ip } }), ctx(token));

function upload(opts: { file?: Blob | null; requestId?: string; ip?: string; token?: string; headers?: Record<string, string>; contentLength?: string | null } = {}) {
  const form = new FormData();
  form.append("requestId", opts.requestId ?? REQUEST_ID);
  if (opts.file !== null) form.append("file", opts.file ?? new Blob([new Uint8Array(DIRTY_JPEG)], { type: "image/jpeg" }), "山田太郎の免許証.jpg");
  const token = opts.token ?? TOKEN;
  const req = new Request(`http://x/submit/${token}/upload`, { method: "POST", body: form, headers: { "x-real-ip": opts.ip ?? nextIp(), ...opts.headers } });
  const contentLength = opts.contentLength === undefined ? "1000" : opts.contentLength;
  if (contentLength !== null) req.headers.set("content-length", contentLength);
  else req.headers.delete("content-length");
  return POST(req, ctx(token));
}

const ORIGINAL = process.env.DEAL_DOC_LINK_SECRET;
afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.DEAL_DOC_LINK_SECRET;
  else process.env.DEAL_DOC_LINK_SECRET = ORIGINAL;
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DEAL_DOC_LINK_SECRET = SECRET;
  pm.dealDocLink.findUnique.mockResolvedValue(openLink);
  pm.dealDocRequest.findFirst.mockResolvedValue({ id: REQUEST_ID, status: "pending" });
  pm.dealDocRequest.findMany.mockResolvedValue([
    { id: REQUEST_ID, label: "本人確認書類", status: "pending", _count: { files: 0 } },
    { id: "r2", label: "住民票", status: "submitted", _count: { files: 2 } },
  ]);
  pm.dealDocFile.count.mockResolvedValue(0);
});

describe("お客様のページ", () => {
  it("書類名と提出状況を出す。トークンは HTML に入れない", async () => {
    const res = await page();
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("本人確認書類");
    expect(html).toContain("届きました(確認中)(2点)");
    expect(html).not.toContain(TOKEN);
    expect(html).not.toContain(PUBLIC_ID);
  });
  it("応答ヘッダを付ける(スクリプトは nonce だけ)", async () => {
    const res = await page();
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const nonce = /script-src 'nonce-([^']+)'/.exec(res.headers.get("content-security-policy") ?? "")?.[1];
    expect(nonce).toBeTruthy();
    expect(await res.text()).toContain(`<script nonce="${nonce}">`);
  });
  it("氏名・住所・金額・ほかの書類の中身を読まない(取引から読むのは状態だけ)", async () => {
    await page();
    const select = pm.dealDocLink.findUnique.mock.calls[0][0].select;
    expect(select.deal).toEqual({ select: { status: true } });
    expect(select.party).toEqual({ select: { role: true, isSelf: true } });
    expect(Object.keys(select).sort()).toEqual(["deal", "dealId", "expiresAt", "id", "party", "partyRole", "revokedAt"]);
    const reqSelect = pm.dealDocRequest.findMany.mock.calls[0][0].select;
    expect(Object.keys(reqSelect).sort()).toEqual(["_count", "id", "label", "status"]);
    expect(JSON.stringify(reqSelect)).not.toMatch(/storageKey|rejectReason|fileName/);
  });
  it("値が DB に入っていても、余計な値が画面に出ない", async () => {
    pm.dealDocLink.findUnique.mockResolvedValue({ ...openLink, deal: { status: "contracted", price: 30_000_000, name: "東京都試験区1-1 試験 太郎" }, party: { role: "seller", isSelf: false, name: "試験 太郎", address: "東京都試験区1-1" } });
    pm.dealDocRequest.findMany.mockResolvedValue([{ id: REQUEST_ID, label: "本人確認書類", status: "rejected", rejectReason: "試験 太郎の差し戻しの理由", _count: { files: 0 } }]);
    const html = await (await page()).text();
    for (const secret of ["試験 太郎", "東京都試験区", "30000000", "差し戻しの理由"]) expect(html).not.toContain(secret);
  });

  it.each([
    ["期限切れ", { ...openLink, expiresAt: new Date(Date.now() - 1000) }],
    ["無効化", { ...openLink, revokedAt: new Date() }],
    ["当事者を消した", { ...openLink, party: null }],
    ["売主を買主に変えた", { ...openLink, party: { role: "buyer", isSelf: false } }],
    ["自社にした", { ...openLink, party: { role: "seller", isSelf: true } }],
    ["中止の取引", { ...openLink, deal: { status: "cancelled" } }],
    ["決済済の取引", { ...openLink, deal: { status: "settled" } }],
    ["行が無い", null],
  ])("%s は同じ 404 の画面", async (_n, link) => {
    pm.dealDocLink.findUnique.mockResolvedValue(link);
    const res = await page();
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("このリンクは使えません");
    expect(html).not.toContain("本人確認書類");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
  });
  it("署名が違えば DB を見ない", async () => {
    const res = await page(nextIp(), `${PUBLIC_ID}.${"B".repeat(43)}`);
    expect(res.status).toBe(404);
    expect(pm.dealDocLink.findUnique).not.toHaveBeenCalled();
  });
  it("鍵が無ければ動かない(既定の鍵で通らない)", async () => {
    delete process.env.DEAL_DOC_LINK_SECRET;
    expect((await page()).status).toBe(404);
    expect((await upload()).status).toBe(404);
    expect(pm.dealDocLink.findUnique).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
  });
  it("短い鍵でも動かない", async () => {
    process.env.DEAL_DOC_LINK_SECRET = "short";
    expect((await page()).status).toBe(404);
  });
  it("同じ端末から開きすぎると 429", async () => {
    const ip = nextIp();
    for (let i = 0; i < 60; i++) expect((await page(ip)).status).toBe(200);
    expect((await page(ip)).status).toBe(429);
    expect((await page()).status).toBe(200);
  });
  it("違うトークンを試し続ける端末は、正しいトークンでも止める", async () => {
    const ip = nextIp();
    for (let i = 0; i < 20; i++) expect((await page(ip, "wrong")).status).toBe(404);
    expect((await page(ip)).status).toBe(429);
  });
});

describe("提出", () => {
  it("受け付けて、位置情報などを除いたものを保存する。元のファイル名は使わない", async () => {
    const res = await upload();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "submitted", count: 1 });
    const [buffer, meta] = storage.upload.mock.calls[0] as unknown as [Buffer, { key: string; mimeType: string; fileName: string }];
    expect(buffer.includes(Buffer.from("Exif"))).toBe(false);
    expect(buffer.includes(Buffer.from("試験 太郎"))).toBe(false);
    expect(meta.key).toMatch(new RegExp(`^deals/${DEAL_ID}/submissions/[0-9a-f-]{36}\\.jpg$`));
    expect(meta.mimeType).toBe("image/jpeg");
    expect(JSON.stringify(meta)).not.toContain("山田太郎");
    expect(pm.dealDocFile.create.mock.calls[0][0].data).not.toHaveProperty("fileName");
    expect(pm.dealDocRequest.update).toHaveBeenCalledWith({ where: { id: REQUEST_ID }, data: { status: "submitted", rejectReason: null } });
  });
  it("提出の応答に保存先などを返さない", async () => {
    expect(await (await upload()).text()).not.toMatch(/deals\/|storageKey|fileUrl/);
  });
  it("監査は事実・取引・件数だけ(PII とトークンとファイル名を入れない)", async () => {
    await upload();
    expect(writeAuditLog).toHaveBeenCalledWith({ action: "deal_doc_submit", targetTable: "deals", targetId: DEAL_ID, detail: { count: 1 } });
    const text = JSON.stringify(writeAuditLog.mock.calls);
    for (const secret of [TOKEN, PUBLIC_ID, "山田太郎", ".jpg", "deals/"]) expect(text).not.toContain(secret);
  });

  it.each([
    ["期限切れ", { ...openLink, expiresAt: new Date(Date.now() - 1000) }],
    ["無効化", { ...openLink, revokedAt: new Date() }],
    ["中止の取引", { ...openLink, deal: { status: "cancelled" } }],
  ])("%s のトークンでは提出できない", async (_n, link) => {
    pm.dealDocLink.findUnique.mockResolvedValue(link);
    const res = await upload();
    expect(res.status).toBe(404);
    expect(storage.upload).not.toHaveBeenCalled();
    expect(pm.dealDocFile.create).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
  it("確かめたあとに無効化されたら記録せず、置いたファイルを消す", async () => {
    pm.dealDocLink.findUnique.mockResolvedValueOnce(openLink).mockResolvedValueOnce({ ...openLink, revokedAt: new Date() });
    const res = await upload();
    expect(res.status).toBe(404);
    expect(pm.dealDocFile.create).not.toHaveBeenCalled();
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
  it("記録に失敗したら、置いたファイルを消す", async () => {
    pm.dealDocFile.create.mockRejectedValueOnce(new Error("db"));
    const res = await upload();
    expect(res.status).toBe(503);
    expect(storage.delete).toHaveBeenCalledTimes(1);
  });
  it("別のリンクの書類には提出できない", async () => {
    pm.dealDocRequest.findFirst.mockResolvedValue(null);
    expect((await upload()).status).toBe(404);
    expect(pm.dealDocRequest.findFirst.mock.calls[0][0].where).toEqual({ id: REQUEST_ID, linkId: "l1" });
    expect(storage.delete).toHaveBeenCalledTimes(1);
  });
  it("受領した書類には提出できない", async () => {
    pm.dealDocRequest.findFirst.mockResolvedValue({ id: REQUEST_ID, status: "received" });
    expect((await upload()).status).toBe(409);
    expect(pm.dealDocFile.create).not.toHaveBeenCalled();
  });
  it("ファイル数の上限を超えると断る", async () => {
    pm.dealDocFile.count.mockResolvedValueOnce(5);
    expect((await upload()).status).toBe(409);
    pm.dealDocFile.count.mockResolvedValueOnce(0).mockResolvedValueOnce(50);
    expect((await upload()).status).toBe(409);
    expect(pm.dealDocFile.create).not.toHaveBeenCalled();
  });

  it.each([
    ["HTML(画像と申告)", new Blob(["<html></html>"], { type: "image/jpeg" })],
    ["SVG", new Blob(["<svg></svg>"], { type: "image/svg+xml" })],
    ["テキスト", new Blob(["hello"], { type: "text/plain" })],
  ])("%s は中身で断る", async (_n, file) => {
    const res = await upload({ file });
    expect(res.status).toBe(422);
    expect(storage.upload).not.toHaveBeenCalled();
  });
  it("ファイルが無ければ断る", async () => {
    expect((await upload({ file: null })).status).toBe(422);
  });
  it("大きさを本文を読む前に断る", async () => {
    expect((await upload({ contentLength: String(DOC_FILE_MAX_BYTES + 2 * 1024 * 1024) })).status).toBe(413);
    expect((await upload({ contentLength: null })).status).toBe(411);
    expect(pm.dealDocLink.findUnique).not.toHaveBeenCalled();
  });
  it("実際のファイルが上限を超えていれば断る", async () => {
    const res = await upload({ file: new Blob([new Uint8Array(DOC_FILE_MAX_BYTES + 1)], { type: "application/pdf" }) });
    expect(res.status).toBe(413);
    expect(storage.upload).not.toHaveBeenCalled();
  });
  it("よそのサイトからの送信は断る", async () => {
    const res = await upload({ headers: { origin: "https://evil.example", host: "app.example" } });
    expect(res.status).toBe(403);
    expect(storage.upload).not.toHaveBeenCalled();
  });
  it("同じ端末からの送りすぎは 429(1分10回)", async () => {
    const ip = nextIp();
    for (let i = 0; i < 10; i++) expect((await upload({ ip })).status).toBe(200);
    const res = await upload({ ip });
    expect(res.status).toBe(429);
    expect((await res.json()).ok).toBe(false);
  });
  it("1つのリンクへの送りすぎは 429(端末を変えても1時間60回)", async () => {
    const publicId = "L".repeat(22);
    const token = buildDocLinkToken(publicId, Buffer.from(SECRET));
    for (let i = 0; i < 60; i++) expect((await upload({ token })).status).toBe(200);
    expect((await upload({ token })).status).toBe(429);
  });
  it("違うトークンを試し続ける端末は止める", async () => {
    const ip = nextIp();
    for (let i = 0; i < 10; i++) expect((await upload({ ip, token: "wrong" })).status).toBe(404);
    for (let i = 0; i < 10; i++) expect((await page(ip, "wrong")).status).toBe(404);
    expect((await upload({ ip })).status).toBe(429);
    expect(storage.upload).not.toHaveBeenCalled();
    expect((await upload()).status).toBe(200);
  });
  it("応答にも no-referrer・noindex・nosniff を付ける", async () => {
    const res = await upload();
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
