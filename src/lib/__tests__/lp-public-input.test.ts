import { describe, it, expect } from "vitest";
import {
  normalizePublicSlug,
  readAdParams,
  AD_PARAM_MAX,
  normalizeGoogleTagId,
  normalizeGoogleConvLabel,
  buildPublicLpHeaders,
  publicLpPath,
} from "@/lib/sale-dm-letter/lp-public";
import { LP_PAGE_HEADERS } from "@/lib/sale-dm-letter/lp-page";

describe("normalizePublicSlug(広告用ページの公開名)", () => {
  it("小文字英数字とハイフン 2〜40字だけを通す(前後の空白は除き・大文字は小文字に)", () => {
    expect(normalizePublicSlug(" Souzoku ")).toBe("souzoku");
    expect(normalizePublicSlug("souzoku-mansion")).toBe("souzoku-mansion");
    expect(normalizePublicSlug("a1")).toBe("a1");
    expect(normalizePublicSlug("a".repeat(40))).toBe("a".repeat(40));
  });
  it("空・空白だけは null(=公開しない)", () => {
    expect(normalizePublicSlug("")).toBeNull();
    expect(normalizePublicSlug("   ")).toBeNull();
    expect(normalizePublicSlug(null)).toBeNull();
  });
  it("規則に合わない文字列は invalid(全角・記号・1字・41字・スラッシュ)", () => {
    for (const bad of ["相続", "a", "a".repeat(41), "sou zoku", "sou/zoku", "sou_zoku", "sou.zoku", "../x"]) {
      expect(normalizePublicSlug(bad), bad).toBe("invalid");
    }
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

describe("Google のタグの設定値", () => {
  it("タグ ID は G-/AW-/GT- + 英数字 4〜20 字(小文字は大文字に・空は null・他は invalid)", () => {
    expect(normalizeGoogleTagId(" aw-12345ABC ")).toBe("AW-12345ABC");
    expect(normalizeGoogleTagId("G-ABCD1234")).toBe("G-ABCD1234");
    expect(normalizeGoogleTagId("")).toBeNull();
    expect(normalizeGoogleTagId(null)).toBeNull();
    for (const bad of ["UA-12345-1", "AW-", "AW-abc", "AW-1234567890123456789012", "AW-12 34", "<script>"]) {
      expect(normalizeGoogleTagId(bad), bad).toBe("invalid");
    }
  });
  it("コンバージョン ラベルは英数字・_・- の 4〜64 字", () => {
    expect(normalizeGoogleConvLabel(" AbCd-12_x ")).toBe("AbCd-12_x");
    expect(normalizeGoogleConvLabel("")).toBeNull();
    for (const bad of ["abc", "a".repeat(65), "ab cd", "ab/cd", "あいうえ"]) {
      expect(normalizeGoogleConvLabel(bad), bad).toBe("invalid");
    }
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
