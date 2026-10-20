import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("next/server", () => ({ NextResponse: Response }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: { dmScenario: { findFirst: vi.fn() } },
}));
vi.mock("@/lib/sale-dm-letter/lp-public-record", () => ({ recordPublicInquiry: vi.fn() }));
vi.mock("@/lib/sale-dm-letter/inquiry-notify", () => ({ startInquiryNotify: vi.fn() }));
vi.mock("@/lib/sale-dm-letter/inquiry-auto-reply", () => ({ startInquiryAutoReply: vi.fn() }));
vi.mock("@/lib/sale-dm-letter/config-store", () => ({
  loadSaleDmPublicPageConfig: vi.fn(),
}));

import { GET } from "@/app/lp/[slug]/route";
import { POST } from "@/app/lp/[slug]/inquiry/route";
import { recordPublicInquiry } from "@/lib/sale-dm-letter/lp-public-record";
import { startInquiryNotify } from "@/lib/sale-dm-letter/inquiry-notify";
import { startInquiryAutoReply } from "@/lib/sale-dm-letter/inquiry-auto-reply";
import { writeAuditLog } from "@/lib/audit";
import prisma from "@/lib/prisma";
import { loadSaleDmPublicPageConfig } from "@/lib/sale-dm-letter/config-store";
import { HONEYPOT_FIELD } from "@/lib/sale-dm-letter/inquiry-input";

const rec = recordPublicInquiry as unknown as ReturnType<typeof vi.fn>;
const notify = startInquiryNotify as unknown as ReturnType<typeof vi.fn>;
const autoReply = startInquiryAutoReply as unknown as ReturnType<typeof vi.fn>;
const audit = writeAuditLog as unknown as ReturnType<typeof vi.fn>;
const findFirst = (prisma as unknown as { dmScenario: { findFirst: ReturnType<typeof vi.fn> } }).dmScenario.findFirst;
const loadCfg = loadSaleDmPublicPageConfig as unknown as ReturnType<typeof vi.fn>;

const CFG = {
  senderName: "株式会社リガーレ", senderContact: "TEL 03-1234-5678", trackingBaseUrl: "https://app.example.com",
  lpPublicEnabled: true, privacyText: null, google: null,
};
const SCENARIO = {
  id: "s1", name: "相続", lpHeadline: "相続した{{物件種別}}の売却", lpLead: null, lpBodyText: "■A\n本文", lpFaqJson: null,
  media: [],
};
const VALID = { name: "山田", phone: "090-1234-5678", consent: "yes" };

// ⚠レート制限はモジュール保持でテスト間リセットされない。IP をテストごとに変える。
let seq = 0;
function ip() {
  seq += 1;
  return `10.8.${Math.floor(seq / 250)}.${seq % 250}`;
}
function get(slug: string, query = "") {
  const req = new Request(`http://localhost:3000/lp/${slug}${query}`, {
    headers: { host: "app.ligarejapan.com", "x-forwarded-for": ip() },
  });
  return GET(req as never, { params: Promise.resolve({ slug }) });
}
function post(fields: Record<string, string>, headers: Record<string, string> = {}, slug = "souzoku") {
  const req = new Request(`http://localhost:3000/lp/${slug}/inquiry`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      host: "app.ligarejapan.com",
      origin: "https://app.ligarejapan.com",
      "x-forwarded-for": ip(),
      ...headers,
    },
    body: new URLSearchParams(fields).toString(),
  });
  return POST(req as never, { params: Promise.resolve({ slug }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  loadCfg.mockResolvedValue({ ...CFG });
  findFirst.mockImplementation(async ({ where }: { where: { publicSlug: string } }) => (where.publicSlug === "souzoku" ? { ...SCENARIO } : null));
  rec.mockResolvedValue({ inquiryId: "inq1" });
});

describe("GET /lp/[slug](広告用の公開ページ)", () => {
  it("公開名が合えば 200・HTML・no-store・隠し欄に広告の印・監査は書かない", async () => {
    const res = await get("souzoku", "?utm_source=google&utm_campaign=aki&gclid=G1&fbclid=x");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toBeNull();
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain("相続した不動産の売却");
    expect(html).toContain('<input type="hidden" name="utm_source" value="google" />');
    expect(html).toContain('<input type="hidden" name="gclid" value="G1" />');
    expect(html).not.toContain("fbclid");
    expect(html).toContain('action="/lp/souzoku/inquiry"');
    expect(audit).not.toHaveBeenCalled();
    // 検索条件は公開名・削除なし・使う
    expect(findFirst.mock.calls[0][0].where).toEqual({ publicSlug: "souzoku", deletedAt: null, active: true });
  });
  it("公開名が大文字でも同じページ(小文字に揃える)", async () => {
    expect((await get("SOUZOKU")).status).toBe(200);
  });
  it("該当なし・規則外の公開名・公開ゲート無効 は 404(本文なし)", async () => {
    expect((await get("akiya")).status).toBe(404);
    expect((await get("sou%20zoku")).status).toBe(404);
    expect((await get("..")).status).toBe(404);
    loadCfg.mockResolvedValue({ ...CFG, lpPublicEnabled: false });
    const r = await get("souzoku");
    expect(r.status).toBe(404);
    expect(await r.text()).toBe("");
  });
  it("DB が落ちていても 500 を出さず 404", async () => {
    findFirst.mockRejectedValueOnce(new Error("db down"));
    expect((await get("souzoku")).status).toBe(404);
  });
});

describe("POST /lp/[slug]/inquiry(広告用の公開ページの申込)", () => {
  it("正しい入力: 記録して 200・通知と受付メールを起動・監査は scenarioId と公開名だけ", async () => {
    const res = await post({ ...VALID, propertyAddress: "世田谷区経堂1-2-3", utm_source: "google", utm_campaign: "aki", gclid: "G1" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("受け付けました");
    expect(rec).toHaveBeenCalledTimes(1);
    const [, scenario, input, ad] = rec.mock.calls[0] as unknown as [unknown, { id: string; slug: string }, Record<string, unknown>, Record<string, unknown>];
    expect(scenario).toEqual({ id: "s1", slug: "souzoku" });
    expect(input).toEqual({ name: "山田", phone: "090-1234-5678", email: null, contactPref: null, contactTime: null, message: null, propertyAddress: "世田谷区経堂1-2-3" });
    expect(ad).toEqual({ utmSource: "google", utmMedium: null, utmCampaign: "aki", utmTerm: null, utmContent: null, gclid: "G1" });
    expect(notify).toHaveBeenCalledWith("inq1");
    expect(autoReply).toHaveBeenCalledWith("inq1");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "lp_public_inquiry_submit", targetTable: "dm_scenarios", targetId: "s1" }));
    const detail = (audit.mock.calls[0] as unknown as [{ detail: Record<string, unknown> }])[0].detail;
    expect(Object.keys(detail).sort()).toEqual(["at", "slug"]);
  });
  it("JS 送信(accept: application/json)は JSON で返す(入力値は含めない)", async () => {
    const res = await post({ ...VALID, propertyAddress: "秘密の住所" }, { accept: "application/json" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ result: "done" });
    expect(text).not.toContain("秘密の住所");
  });
  it("honeypot が埋まっていれば「受け付けました」を返して何も記録しない。JS 送信には silent を添える(コンバージョンを送らせない)", async () => {
    const res = await post({ ...VALID, [HONEYPOT_FIELD]: "x" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("受け付けました");
    expect(rec).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
    const j = await post({ ...VALID, [HONEYPOT_FIELD]: "x" }, { accept: "application/json" });
    expect(JSON.parse(await j.text())).toEqual({ result: "done", silent: true });
    // 本物の申込には silent を付けない
    const real = await post(VALID, { accept: "application/json" });
    expect(JSON.parse(await real.text())).toEqual({ result: "done" });
  });
  it("入力の不備は 422(所在地が長すぎる)で、入力値は返さない", async () => {
    const res = await post({ ...VALID, propertyAddress: "あ".repeat(201) }, { accept: "application/json" });
    expect(res.status).toBe(422);
    const body = JSON.parse(await res.text());
    expect(body.result).toBe("invalid");
    expect(body.messages.join("")).toContain("物件の所在地");
    expect(rec).not.toHaveBeenCalled();
  });
  it("よそのサイトからの送信は 403・公開名が規則外/該当なし/文章なし/公開ゲート無効 は 404(記録なし)", async () => {
    expect((await post(VALID, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(VALID, {}, "sou zoku")).status).toBe(404);
    expect((await post(VALID, {}, "akiya")).status).toBe(404);
    findFirst.mockResolvedValueOnce({ ...SCENARIO, lpBodyText: "  " });
    expect((await post(VALID)).status).toBe(404);
    loadCfg.mockResolvedValue({ ...CFG, lpPublicEnabled: false });
    expect((await post(VALID)).status).toBe(404);
    expect(rec).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
  it("同じ端末からは1時間に5件まで(6件目は 429)=公開名の枠を1つの端末で使い切れない", async () => {
    const fixedIp = { "x-forwarded-for": "10.99.0.1" };
    for (let i = 0; i < 5; i += 1) expect((await post(VALID, fixedIp)).status).toBe(200);
    expect((await post(VALID, fixedIp)).status).toBe(429);
    expect(rec).toHaveBeenCalledTimes(5);
  });
  it("本文の形式が違えば 415・記録に失敗したら 503(busy)", async () => {
    expect((await post(VALID, { "content-type": "application/json" })).status).toBe(415);
    rec.mockRejectedValueOnce(new Error("db"));
    expect((await post(VALID)).status).toBe(503);
    expect(notify).not.toHaveBeenCalled();
  });
});
