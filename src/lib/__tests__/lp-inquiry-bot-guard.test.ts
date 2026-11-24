import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

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
import { writeAuditLog } from "@/lib/audit";
import prisma from "@/lib/prisma";
import { loadSaleDmPublicPageConfig } from "@/lib/sale-dm-letter/config-store";
import { HONEYPOT_FIELD } from "@/lib/sale-dm-letter/inquiry-input";
import {
  deriveLpFormStampKey, evaluateLpBotSignals, issueLpFormStamp, lpStampHiddenFields, LP_MIN_FILL_MS,
} from "@/lib/sale-dm-letter/lp-form-stamp";
import { LP_DESIGN_BY_SLUG, renderLpDesignPage, LP_DESIGN_KEYS } from "@/lib/sale-dm-letter/lp-design-pages";
import { renderLpPage } from "@/lib/sale-dm-letter/lp-page";
import type { LpRenderInput } from "@/lib/sale-dm-letter/lp-render-input";
import { sanitizeAuditDetail } from "@/lib/audit-log-detail-safety";
import { safeUtmValue } from "@/lib/sale-dm-letter/lp-public";

// 2026-11-24 発注者「公開LPの申込受け口に、ボット対策と『ボット記録』を足す」

const SECRET = "test-secret-for-lp-form-stamp-0123456789";
const KEY = deriveLpFormStampKey(SECRET)!;

const rec = recordPublicInquiry as unknown as ReturnType<typeof vi.fn>;
const audit = writeAuditLog as unknown as ReturnType<typeof vi.fn>;
const findFirst = (prisma as unknown as { dmScenario: { findFirst: ReturnType<typeof vi.fn> } }).dmScenario.findFirst;
const loadCfg = loadSaleDmPublicPageConfig as unknown as ReturnType<typeof vi.fn>;

const CFG = {
  senderName: "株式会社リガーレ", senderContact: "TEL 03-1234-5678", trackingBaseUrl: "https://app.example.com",
  lpPublicEnabled: true, privacyText: null, google: null,
};
const SCENARIO = {
  id: "s1", name: "売却", autoKey: null, lpHeadline: "売却の見出し", lpLead: null, lpBodyText: "■A\n本文", lpFaqJson: null, media: [],
};
const VALID = { name: "山田太郎", phone: "090-1234-5678", consent: "yes" };
const AD = { utm_source: "smartnews", utm_campaign: "camp1", utm_content: "cr1", utm_medium: "display", gclid: "GCLID-SECRET-VALUE" };

let seq = 0;
function ip() {
  seq += 1;
  return `10.9.${Math.floor(seq / 250)}.${seq % 250}`;
}
function get(slug: string) {
  const req = new Request(`http://localhost:3000/lp/${slug}`, { headers: { host: "app.ligarejapan.com", "x-forwarded-for": ip() } });
  return GET(req as never, { params: Promise.resolve({ slug }) });
}
function post(fields: Record<string, string>, slug = "baikyaku", headers: Record<string, string> = {}) {
  const req = new Request(`http://localhost:3000/lp/${slug}/inquiry`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      host: "app.ligarejapan.com",
      origin: "https://app.ligarejapan.com",
      "x-forwarded-for": ip(),
      "user-agent": "BotUA/1.0",
      ...headers,
    },
    body: new URLSearchParams(fields).toString(),
  });
  return POST(req as never, { params: Promise.resolve({ slug }) });
}
/** 表示から ageMs たった正しい印(lp_js は humanJs で入れる)。 */
function stamp(slug: string, ageMs: number, humanJs = true): Record<string, string> {
  const s = issueLpFormStamp(slug, Date.now() - ageMs, KEY)!;
  return { lp_t: s.t, lp_ts: s.sig, ...(humanJs ? { lp_js: "1" } : {}) };
}
const botCalls = (action: string) => audit.mock.calls.map((c) => c[0] as { action: string; detail: Record<string, unknown> }).filter((a) => a.action === action);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXTAUTH_SECRET", SECRET);
  loadCfg.mockResolvedValue({ ...CFG });
  findFirst.mockImplementation(async ({ where }: { where: { publicSlug: string } }) =>
    (where.publicSlug === "souzoku" || where.publicSlug in LP_DESIGN_BY_SLUG ? { ...SCENARIO } : null));
  rec.mockResolvedValue({ kind: "recorded", inquiryId: "inq1" });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("判定(evaluateLpBotSignals・純関数)", () => {
  const base = { slug: "baikyaku", js: "1", key: KEY };
  const at = (ageMs: number, slug = "baikyaku") => issueLpFormStamp(slug, 1_800_000_000_000 - ageMs, KEY)!;
  const now = 1_800_000_000_000;
  it("署名が正しく2秒未満は blocked(too_fast)。境目の2秒ちょうどは通す", () => {
    const s = at(1_000);
    expect(evaluateLpBotSignals({ ...base, t: s.t, sig: s.sig, nowMs: now })).toEqual({ kind: "blocked", reason: "too_fast" });
    const s2 = issueLpFormStamp("baikyaku", now, KEY)!;
    expect(evaluateLpBotSignals({ ...base, t: s2.t, sig: s2.sig, nowMs: now + LP_MIN_FILL_MS - 1 }).kind).toBe("blocked");
    expect(evaluateLpBotSignals({ ...base, t: s2.t, sig: s2.sig, nowMs: now + LP_MIN_FILL_MS })).toEqual({ kind: "ok" });
  });
  it("署名が正しく2秒以上・lp_js=1 は ok(古いページからの送信も止めない)", () => {
    const s = at(3 * 86_400_000);
    expect(evaluateLpBotSignals({ ...base, t: s.t, sig: s.sig, nowMs: now })).toEqual({ kind: "ok" });
  });
  it("lp_js が無い・1 でない → suspect(no_js)", () => {
    const s = at(5_000);
    expect(evaluateLpBotSignals({ ...base, js: null, t: s.t, sig: s.sig, nowMs: now })).toEqual({ kind: "suspect", reasons: ["no_js"] });
    expect(evaluateLpBotSignals({ ...base, js: "", t: s.t, sig: s.sig, nowMs: now })).toEqual({ kind: "suspect", reasons: ["no_js"] });
  });
  it("署名なし・改ざん・別の公開名の署名・時刻の書き換え・鍵なし → suspect(bad_sig)=止めない(速くても)", () => {
    const s = at(0);
    const cases = [
      { t: null, sig: null, key: KEY },
      { t: s.t, sig: s.sig.slice(0, -1) + (s.sig.endsWith("A") ? "B" : "A"), key: KEY },
      { t: at(0, "souzoku").t, sig: at(0, "souzoku").sig, key: KEY, slug: "baikyaku" },
      { t: String(Number(s.t) - 100), sig: s.sig, key: KEY },
      { t: s.t, sig: s.sig, key: null },
      { t: "abc", sig: "!!", key: KEY },
    ];
    for (const c of cases) {
      expect(evaluateLpBotSignals({ ...base, ...c, nowMs: now })).toEqual({ kind: "suspect", reasons: ["bad_sig"] });
    }
    expect(evaluateLpBotSignals({ ...base, js: null, t: null, sig: null, nowMs: now })).toEqual({ kind: "suspect", reasons: ["no_js", "bad_sig"] });
  });
  it("鍵は NEXTAUTH_SECRET から用途別に導出・未設定/空は null(署名を出さない)", () => {
    vi.stubEnv("NEXTAUTH_SECRET", "");
    expect(deriveLpFormStampKey()).toBeNull();
    expect(deriveLpFormStampKey("")).toBeNull();
    expect(deriveLpFormStampKey("  ")).toBeNull();
    expect(issueLpFormStamp("baikyaku", now, null)).toBeNull();
    expect(deriveLpFormStampKey(SECRET)!.equals(KEY)).toBe(true);
    expect(deriveLpFormStampKey("other")!.equals(KEY)).toBe(false);
  });
  it("隠し欄: 印が無い・形が違うときは lp_js だけ", () => {
    expect(lpStampHiddenFields(null, false)).toBe('<input type="hidden" name="lp_js" value="">');
    expect(lpStampHiddenFields({ t: '1"><x', sig: "a".repeat(22) }, true)).toBe('<input type="hidden" name="lp_js" value="" />');
  });
});

describe("フォームの隠し欄(5つの見た目すべて+今の LP)", () => {
  const formsOf = (html: string) => html.match(/<form[\s\S]*?<\/form>/g) ?? [];
  it.each(Object.entries(LP_DESIGN_BY_SLUG))("公開名 %s(%s)のすべての申込フォームに lp_t・lp_ts・lp_js が出る", async (slug) => {
    const res = await get(slug);
    expect(res.status).toBe(200);
    const html = await res.text();
    const forms = formsOf(html).filter((f) => f.includes("data-inquiry"));
    expect(forms.length).toBeGreaterThan(0);
    for (const f of forms) {
      const t = /name="lp_t" value="(\d+)"/.exec(f);
      const sig = /name="lp_ts" value="([A-Za-z0-9_-]{22})"/.exec(f);
      expect(t).not.toBeNull();
      expect(sig).not.toBeNull();
      expect(f).toContain('name="lp_js" value=""');
      // 描いた時刻に公開名で署名されている
      expect(evaluateLpBotSignals({ slug, t: t![1], sig: sig![1], js: "1", nowMs: Number(t![1]) * 1000 + 10_000, key: KEY })).toEqual({ kind: "ok" });
    }
    // 操作で lp_js を "1" にする処理がページにある
    expect(html).toContain('input[name="lp_js"]');
  });
  it("form 案は申込フォームが2つ=両方に出る", async () => {
    const html = await (await get("baikyaku-form")).text();
    const forms = formsOf(html).filter((f) => f.includes("data-inquiry"));
    expect(forms.length).toBe(2);
  });
  it("今の LP(相続)にも出る", async () => {
    const html = await (await get("souzoku")).text();
    expect(html).toMatch(/name="lp_t" value="\d+" \/>/);
    expect(html).toMatch(/name="lp_ts" value="[A-Za-z0-9_-]{22}" \/>/);
    expect(html).toContain('name="lp_js" value="" />');
  });
  it("鍵(NEXTAUTH_SECRET)が無いときは lp_t・lp_ts を出さない(lp_js だけ)", async () => {
    vi.stubEnv("NEXTAUTH_SECRET", "");
    const html = await (await get("baikyaku")).text();
    expect(html).not.toContain('name="lp_t"');
    expect(html).not.toContain('name="lp_ts"');
    expect(html).toContain('name="lp_js"');
  });
  it("DM 用の LP(public なし)には隠し欄を出さない", () => {
    const dm: LpRenderInput = {
      mode: "live", headline: "見出し", lead: null, intro: [], sections: [], faq: [], hero: null,
      company: { name: "株式会社リガーレ", contact: null, phone: null }, unsubscribeUrl: null, phoneTapToken: null,
      form: { action: "/t/abc/inquiry", privacyText: "個人情報", disabled: false }, public: null, tagline: "",
    } as LpRenderInput;
    expect(renderLpPage(dm)).not.toContain('<input type="hidden" name="lp_');
    for (const d of LP_DESIGN_KEYS) expect(renderLpDesignPage(d, dm)).not.toContain('<input type="hidden" name="lp_');
  });
});

describe("受け口(POST /lp/[slug]/inquiry)", () => {
  it("ページを開いてすぐ(2秒未満)の送信は「受け付けました」・silent で、申込に残さない。ボット記録(too_fast)だけ", async () => {
    const html = await (await get("baikyaku")).text();
    const t = /name="lp_t" value="(\d+)"/.exec(html)![1];
    const sig = /name="lp_ts" value="([^"]+)"/.exec(html)![1];
    const res = await post({ ...VALID, ...AD, lp_t: t, lp_ts: sig, lp_js: "1" }, "baikyaku", { accept: "application/json" });
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text())).toEqual({ result: "done", silent: true });
    expect(rec).not.toHaveBeenCalled();
    expect(findFirst).toHaveBeenCalledTimes(1); // GET の1回だけ=受け口は種類も引かない
    const b = botCalls("lp_inquiry_bot_blocked");
    expect(b).toHaveLength(1);
    expect(b[0].detail).toEqual({ slug: "baikyaku", reasons: ["too_fast"], utmSource: "smartnews", utmCampaign: "camp1", utmContent: "cr1", hasGclid: true });
    expect(botCalls("lp_public_inquiry_submit")).toHaveLength(0);
  });
  it("JS なしの通常送信でも、速すぎれば「受け付けました」の画面(silent)で残さない", async () => {
    const res = await post({ ...VALID, ...stamp("baikyaku", 500, false) });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("受け付けました");
    expect(rec).not.toHaveBeenCalled();
  });
  it("2秒以上・lp_js=1・署名が正しい=今までどおり記録し、ボット記録は書かない", async () => {
    const res = await post({ ...VALID, ...stamp("baikyaku", 5_000) }, "baikyaku", { accept: "application/json" });
    expect(JSON.parse(await res.text())).toEqual({ result: "done" });
    expect(rec).toHaveBeenCalledTimes(1);
    expect(botCalls("lp_inquiry_bot_suspect")).toHaveLength(0);
    expect(botCalls("lp_inquiry_bot_blocked")).toHaveLength(0);
  });
  it("lp_js なし・署名なしでも、正しい入力なら今までどおり申込が残る。ボット記録に「入力操作なし」(no_js・bad_sig)", async () => {
    const res = await post({ ...VALID, ...AD }, "baikyaku-form", { accept: "application/json" });
    expect(JSON.parse(await res.text())).toEqual({ result: "done" }); // silent を付けない=コンバージョンは送られる
    expect(rec).toHaveBeenCalledTimes(1);
    expect(botCalls("lp_public_inquiry_submit")).toHaveLength(1);
    const s = botCalls("lp_inquiry_bot_suspect");
    expect(s).toHaveLength(1);
    expect(s[0].detail).toEqual({ slug: "baikyaku-form", reasons: ["no_js", "bad_sig"], utmSource: "smartnews", utmCampaign: "camp1", utmContent: "cr1", hasGclid: true });
  });
  it("署名が正しく lp_js だけ無い → 受け付けて no_js / 署名を改ざん・鍵なし → 受け付けて bad_sig", async () => {
    await post({ ...VALID, ...stamp("baikyaku", 5_000, false) });
    const st = stamp("baikyaku", 0);
    await post({ ...VALID, ...st, lp_t: String(Number(st.lp_t) - 60) }); // 時刻を古く書き換えても速すぎの判定をすり抜けられない
    vi.stubEnv("NEXTAUTH_SECRET", "");
    await post({ ...VALID, ...stamp("baikyaku", 0) });
    expect(rec).toHaveBeenCalledTimes(3);
    expect(botCalls("lp_inquiry_bot_suspect").map((c) => c.detail.reasons)).toEqual([["no_js"], ["bad_sig"], ["bad_sig"]]);
  });
  it("別の公開名のページの印を流用しても bad_sig(止めないが記録)", async () => {
    await post({ ...VALID, ...stamp("souzoku", 0) }, "baikyaku");
    expect(rec).toHaveBeenCalledTimes(1);
    expect(botCalls("lp_inquiry_bot_suspect")[0].detail.reasons).toEqual(["bad_sig"]);
  });
  it("honeypot は今までどおり silent・記録なし+ボット記録(honeypot)", async () => {
    const res = await post({ ...VALID, [HONEYPOT_FIELD]: "x", ...stamp("baikyaku", 5_000) }, "baikyaku", { accept: "application/json" });
    expect(JSON.parse(await res.text())).toEqual({ result: "done", silent: true });
    expect(rec).not.toHaveBeenCalled();
    expect(botCalls("lp_inquiry_bot_blocked").map((c) => c.detail)).toEqual([
      { slug: "baikyaku", reasons: ["honeypot"], utmSource: null, utmCampaign: null, utmContent: null, hasGclid: false },
    ]);
  });
  it("入力の不備(422)は申込もボット記録も残さない", async () => {
    const res = await post({ name: "", phone: "", consent: "yes" });
    expect(res.status).toBe(422);
    expect(rec).not.toHaveBeenCalled();
    expect(botCalls("lp_inquiry_bot_suspect")).toHaveLength(0);
  });
  it("ボット記録に IP・UA・入力値・gclid の値が入らない(書いたものも、監査画面で読めるものも)", async () => {
    const xff = "203.0.113.77";
    await post({ ...VALID, ...AD, propertyAddress: "世田谷区経堂9-9-9", email: "x@example.com", message: "秘密の要望" }, "baikyaku", { "x-forwarded-for": xff });
    await post({ ...VALID, ...AD, [HONEYPOT_FIELD]: "spam" }, "baikyaku", { "x-forwarded-for": "203.0.113.78" });
    await post({ ...VALID, ...AD, ...stamp("baikyaku", 0) }, "baikyaku", { "x-forwarded-for": "203.0.113.79" });
    const bots = audit.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((a) => String(a.action).startsWith("lp_inquiry_bot_"));
    expect(bots).toHaveLength(3);
    for (const a of bots) {
      const all = JSON.stringify(a);
      for (const v of ["203.0.113", "BotUA", "山田太郎", "090-1234-5678", "経堂", "x@example.com", "秘密の要望", "spam", "GCLID-SECRET-VALUE"]) {
        expect(all).not.toContain(v);
      }
      expect(a.ipAddress).toBeUndefined();
      expect(a.userAgent).toBeUndefined();
      expect(Object.keys(a.detail as object).sort()).toEqual(["hasGclid", "reasons", "slug", "utmCampaign", "utmContent", "utmSource"]);
      // 監査ログの画面(安全化のあと)でも同じ中身が読める
      expect(sanitizeAuditDetail(a.action as string, a.detail)).toEqual(a.detail);
    }
  });
  it("utm に電話・メール・日本語など形の怪しい値が入っていたら、ボット記録では null(値を残さない)", async () => {
    await post({ ...VALID, utm_source: "090-1234-5678", utm_campaign: "taro@example.com", utm_content: "山田様" });
    await post({ ...VALID, [HONEYPOT_FIELD]: "x", utm_source: "a b", utm_campaign: "x".repeat(101), utm_content: "ok_1.v-2" });
    expect(botCalls("lp_inquiry_bot_suspect")[0].detail).toMatchObject({ utmSource: null, utmCampaign: null, utmContent: null });
    expect(botCalls("lp_inquiry_bot_blocked")[0].detail).toMatchObject({ utmSource: null, utmCampaign: null, utmContent: "ok_1.v-2" });
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(/090-1234-5678|taro@example\.com|山田様/);
    expect(safeUtmValue("03.1234.5678")).toBeNull();
    expect(safeUtmValue("09012345678")).toBeNull();
    // 国番号つき・区切りの違い・前後に文字があっても、10桁以上の数字の並びは残さない(@codex #785 P1)
    for (const v of ["81-90-1234-5678", "819012345678", "+81", "tel09012345678", "0120.123.456", "1-800-555-0199x", "camp_81_3_1234_5678"]) {
      expect(safeUtmValue(v)).toBeNull();
    }
    expect(safeUtmValue("123456789")).toBe("123456789"); // 9桁以下の数字の ID は残す
    expect(safeUtmValue("2026-11-24")).toBe("2026-11-24"); // 日付(8桁)は残す
    expect(safeUtmValue("smartnews")).toBe("smartnews");
    expect(rec).toHaveBeenCalledTimes(1); // 申込の受け付けは変わらない(広告の印は申込の方には今までどおり残る)
  });
  it("ボット記録は action ごとに1時間60件まで(大量送信で監査が埋まらない)。申込の受け付け方は変わらない", async () => {
    const before = botCalls("lp_inquiry_bot_blocked").length; // clearAllMocks 後なので 0
    expect(before).toBe(0);
    for (let i = 0; i < 70; i += 1) {
      const r = await post({ ...VALID, [HONEYPOT_FIELD]: "x" });
      expect(r.status).toBe(200);
    }
    const n = botCalls("lp_inquiry_bot_blocked").length;
    // ほかのテストで使った分を差し引いても上限を超えない・最後の数件は書かれていない
    expect(n).toBeLessThanOrEqual(60);
    expect(n).toBeLessThan(70);
  });
});
