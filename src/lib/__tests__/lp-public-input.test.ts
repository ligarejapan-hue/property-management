import { describe, it, expect } from "vitest";
import {
  normalizePublicSlug,
  normalizedValue,
  readAdParams,
  safeAdQuery,
  AD_PARAM_MAX,
  normalizeGoogleTagId,
  normalizeGoogleConvLabel,
  googleConversionTarget,
  buildPublicLpHeaders,
  publicLpPath,
} from "@/lib/sale-dm-letter/lp-public";
import { LP_PAGE_HEADERS } from "@/lib/sale-dm-letter/lp-page";

describe("normalizePublicSlug(広告用ページの公開名)", () => {
  it("小文字英数字とハイフン 2〜40字だけを通す(前後の空白は除き・大文字は小文字に)", () => {
    expect(normalizePublicSlug(" Souzoku ")).toEqual({ kind: "ok", value: "souzoku" });
    expect(normalizePublicSlug("souzoku-mansion")).toEqual({ kind: "ok", value: "souzoku-mansion" });
    expect(normalizePublicSlug("a1")).toEqual({ kind: "ok", value: "a1" });
    expect(normalizePublicSlug("a".repeat(40))).toEqual({ kind: "ok", value: "a".repeat(40) });
  });
  it("空・空白だけは empty(=公開しない)", () => {
    expect(normalizePublicSlug("")).toEqual({ kind: "empty" });
    expect(normalizePublicSlug("   ")).toEqual({ kind: "empty" });
    expect(normalizePublicSlug(null)).toEqual({ kind: "empty" });
  });
  it("規則に合わない文字列は invalid(全角・記号・1字・41字・スラッシュ)", () => {
    for (const bad of ["相続", "a", "a".repeat(41), "sou zoku", "sou/zoku", "sou_zoku", "sou.zoku", "../x"]) {
      expect(normalizePublicSlug(bad), bad).toEqual({ kind: "invalid" });
    }
  });
  it("「invalid」という公開名は規則上は有効=目印と衝突しない(@codex #535 R4)", () => {
    expect(normalizePublicSlug("invalid")).toEqual({ kind: "ok", value: "invalid" });
    expect(normalizedValue(normalizePublicSlug("invalid"))).toBe("invalid");
    expect(normalizedValue(normalizePublicSlug("x"))).toBeNull();
    expect(normalizedValue(normalizePublicSlug(""))).toBeNull();
  });
});

describe("readAdParams(どの広告から来たか)", () => {
  const get = (m: Record<string, string>) => (k: string) => (k in m ? m[k] : null);
  it("utm_* と gclid を読む。無い欄は null", () => {
    expect(readAdParams(get({ utm_source: "google", utm_campaign: "aki" }))).toEqual({
      utmSource: "google", utmMedium: null, utmCampaign: "aki", utmTerm: null, utmContent: null, gclid: null,
    });
  });
  it(`前後の空白を除き・制御文字を落とし・${AD_PARAM_MAX}字で切る。空は null`, () => {
    const p = readAdParams(get({ utm_source: "  go\u0000og\nle ", utm_medium: "", gclid: "x".repeat(500) }));
    expect(p.utmSource).toBe("google");
    expect(p.utmMedium).toBeNull();
    expect(p.gclid).toBe("x".repeat(AD_PARAM_MAX));
  });
  it("それ以外の欄は拾わない(型は6つの鍵だけ)", () => {
    const p = readAdParams(get({ fbclid: "y", utm_source: "meta" }));
    expect(Object.keys(p).sort()).toEqual(["gclid", "utmCampaign", "utmContent", "utmMedium", "utmSource", "utmTerm"]);
  });
});

describe("safeAdQuery(Google のタグに渡してよい印だけの query・@codex #535 R4 P1)", () => {
  const get = (m: Record<string, string>) => (k: string) => (k in m ? m[k] : null);
  it("英数字と . _ - だけの値を付け直す。@ や空白・日本語を含む値(連絡先が紛れ得る)は落とす", () => {
    const q = safeAdQuery(readAdParams(get({
      utm_source: "google", utm_medium: "cpc", utm_campaign: "taro@example.jp", utm_term: "090 1234 5678", utm_content: "秋", gclid: "Cj0KCQ-abc_123",
    })));
    expect(q).toBe("?utm_source=google&utm_medium=cpc&gclid=Cj0KCQ-abc_123");
  });
  it("印が無ければ空文字", () => {
    expect(safeAdQuery(readAdParams(get({})))).toBe("");
    expect(safeAdQuery(readAdParams(get({ utm_campaign: "a b" })))).toBe("");
  });
  it("100字を超える utm と 200字を超える gclid は落とす", () => {
    expect(safeAdQuery(readAdParams(get({ utm_source: "a".repeat(101) })))).toBe("");
    expect(safeAdQuery(readAdParams(get({ utm_source: "a".repeat(100) })))).toBe(`?utm_source=${"a".repeat(100)}`);
  });
});

describe("Google のタグの設定値", () => {
  it("タグ ID は G-/AW-/GT- + 英数字 4〜20 字(小文字は大文字に・空は empty・他は invalid)", () => {
    expect(normalizeGoogleTagId(" aw-12345ABC ")).toEqual({ kind: "ok", value: "AW-12345ABC" });
    expect(normalizeGoogleTagId("G-ABCD1234")).toEqual({ kind: "ok", value: "G-ABCD1234" });
    expect(normalizeGoogleTagId("")).toEqual({ kind: "empty" });
    expect(normalizeGoogleTagId(null)).toEqual({ kind: "empty" });
    for (const bad of ["UA-12345-1", "AW-", "AW-abc", "AW-1234567890123456789012", "AW-12 34", "<script>"]) {
      expect(normalizeGoogleTagId(bad), bad).toEqual({ kind: "invalid" });
    }
  });
  it("コンバージョン ラベルは英数字・_・- の 4〜64 字(「invalid」も有効な値)", () => {
    expect(normalizeGoogleConvLabel(" AbCd-12_x ")).toEqual({ kind: "ok", value: "AbCd-12_x" });
    expect(normalizeGoogleConvLabel("invalid")).toEqual({ kind: "ok", value: "invalid" });
    expect(normalizeGoogleConvLabel("")).toEqual({ kind: "empty" });
    for (const bad of ["abc", "a".repeat(65), "ab cd", "ab/cd", "あいうえ"]) {
      expect(normalizeGoogleConvLabel(bad), bad).toEqual({ kind: "invalid" });
    }
  });
  it("send_to をまるごと(AW-数字/ラベル)入れてもよい=AW- の部分は大文字にそろえる(GA4 の ID と並べて使う・2026-11-15 発注者)", () => {
    expect(normalizeGoogleConvLabel(" aw-123456789/AbCd-12_x ")).toEqual({ kind: "ok", value: "AW-123456789/AbCd-12_x" });
    for (const bad of ["G-ABCD1234/AbCd-12_x", "GT-ABCD1234/AbCd-12_x", "AW-123/AbCd", "AW-123456789/", "AW-123456789/ab", "AW-123456789/AbCd/x", "/AbCd-12_x", "AW-1234 5678/AbCd-12_x"]) {
      expect(normalizeGoogleConvLabel(bad), bad).toEqual({ kind: "invalid" });
    }
  });
  it("googleConversionTarget: 成果の送り先(send_to)と、追加で読み込む Google広告の ID", () => {
    // ラベルが send_to まるごと → タグ ID が G- でも送る・AW- を追加で config
    expect(googleConversionTarget({ tagId: "G-ABCD1234", convLabel: "AW-123456789/AbCd-12_x" })).toEqual({ sendTo: "AW-123456789/AbCd-12_x", extraConfigId: "AW-123456789" });
    // タグ ID と同じ AW- なら追加の config は要らない
    expect(googleConversionTarget({ tagId: "AW-123456789", convLabel: "AW-123456789/AbCd-12_x" })).toEqual({ sendTo: "AW-123456789/AbCd-12_x", extraConfigId: null });
    // 今までどおり: AW- のタグ ID+ラベルだけ
    expect(googleConversionTarget({ tagId: "AW-12345ABC", convLabel: "AbCd-12_x" })).toEqual({ sendTo: "AW-12345ABC/AbCd-12_x", extraConfigId: null });
    // G-/GT- にラベルだけ・ラベルなし=送らない
    expect(googleConversionTarget({ tagId: "G-ABCD1234", convLabel: "AbCd-12_x" })).toBeNull();
    expect(googleConversionTarget({ tagId: "AW-12345ABC", convLabel: null })).toBeNull();
  });
});

describe("buildPublicLpHeaders(広告ページの応答ヘッダ)", () => {
  it("Google のタグが無ければ DM 用と同じ CSP(外部読み込みなし)・検索よけの X-Robots-Tag は付けない", () => {
    const h = buildPublicLpHeaders(null);
    expect(h["Content-Security-Policy"]).toBe(LP_PAGE_HEADERS["Content-Security-Policy"]);
    expect(h["X-Robots-Tag"]).toBeUndefined();
    expect(h["Cache-Control"]).toBe("no-store");
    expect(h["Content-Type"]).toContain("text/html");
  });
  it("Google のタグがあるときだけ、タグの配信元と計測の通信先を script/connect/img/frame に足す", () => {
    const csp = buildPublicLpHeaders({ tagId: "AW-12345ABC", convLabel: null })["Content-Security-Policy"];
    expect(csp).toMatch(/script-src [^;]*https:\/\/www\.googletagmanager\.com/);
    expect(csp).toMatch(/connect-src [^;]*https:\/\/\*\.google-analytics\.com/);
    expect(csp).toMatch(/connect-src [^;]*https:\/\/googleads\.g\.doubleclick\.net/);
    expect(csp).toMatch(/img-src [^;]*https:\/\/www\.google\.com/);
    // Google広告の成果は画像で送られることもある(ビーコンが使えないとき)
    expect(csp).toMatch(/img-src [^;]*https:\/\/\*\.googleadservices\.com/);
    expect(csp).toMatch(/frame-src https:\/\/td\.doubleclick\.net https:\/\/www\.googletagmanager\.com/);
    // 守りの基本は変えない
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});

describe("publicLpPath", () => {
  it("/lp/<公開名>", () => {
    expect(publicLpPath("souzoku")).toBe("/lp/souzoku");
  });
});
