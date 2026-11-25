import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
vi.mock("@/lib/sale-dm-letter/config-store", () => ({
  loadSaleDmPublicPageConfig: vi.fn(),
}));
import { loadPublicLpPage } from "@/lib/sale-dm-letter/lp-public-loader";
import { loadSaleDmPublicPageConfig } from "@/lib/sale-dm-letter/config-store";
import {
  LP_DESIGN_BY_SLUG, LP_DESIGN_KEYS, LP_SATEI_SAMPLE, QUESTION_COMPOSE_SOURCE, lpDesignAsksContactPref, lpDesignForSlug, renderLpDesignPage, type LpDesignKey,
} from "@/lib/sale-dm-letter/lp-design-pages";
import { LP_DESIGN_COMMON_CSS, LP_DESIGN_EXTRA_CSS } from "@/lib/sale-dm-letter/lp-design-styles";
import { INQUIRY_CLIENT_CHECK_SOURCE, LP_PAGE_HEADERS } from "@/lib/sale-dm-letter/lp-page";
import type { LpRenderInput } from "@/lib/sale-dm-letter/lp-render-input";
import { parseInquiryForm } from "@/lib/sale-dm-letter/inquiry-input";

// 2026-11-24 発注者「売却の代表LP 5つの見た目(比較テスト用)」(設計 docs/superpowers/specs/2026-11-24-lp-design-ab/README.md)

const SPEC = join(process.cwd(), "docs/superpowers/specs/2026-11-24-lp-design-ab");
const SAMPLE: Record<LpDesignKey, string> = {
  base: "design-0-base.html", form: "design-1-form.html", question: "design-2-question.html",
  compare: "design-5-compare.html", editorial: "design-8-editorial.html",
};
const NO_AD = { utmSource: null, utmMedium: null, utmCampaign: null, utmTerm: null, utmContent: null, gclid: null };
const PRIVACY = "当社は、ご入力いただいた個人情報を査定のご連絡のためにのみ使います。";

const input = (over: Partial<LpRenderInput> = {}, pubOver: Partial<NonNullable<LpRenderInput["public"]>> = {}): LpRenderInput => ({
  mode: "public", headline: "見出し", lead: null, intro: [], sections: [], faq: [], hero: null,
  company: { name: "株式会社リガーレジャパン", contact: "TEL 03-6823-2760", phone: "0368232760" },
  unsubscribeUrl: null, phoneTapToken: null,
  form: { action: "/lp/baikyaku/inquiry", privacyText: PRIVACY, disabled: false },
  public: { adParams: NO_AD, safeQuery: "", google: null, og: { url: "https://app.example.com/lp/baikyaku", imageUrl: null }, ...pubOver },
  tagline: "",
  ...over,
} as LpRenderInput);

/** 画面に出る文字(タグの間の文字)を順に取り出す。head・script・style は除く。 */
function texts(html: string): string[] {
  const body = html.slice(html.indexOf("<body")).replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<svg[\s\S]*?<\/svg>/g, "");
  return body.split(/<[^>]*>/).map((t) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim()).filter(Boolean);
}
/** 見本だけの文言(本番では今の LP と同じものに置き換える)。 */
const SAMPLE_ONLY = new Set([
  "確認用の見本のため、送信はされません。本番では、ここで申し込みが完了します。",
  "（本番では、今のLPと同じ個人情報の取り扱いの文面がここに入ります）",
]);
/** 本番だけの文言(今の LP と同じ個人情報の取り扱いの文面・プライバシーポリシーへの案内)。 */
const PROD_ONLY = new Set([PRIVACY, "詳しくは当社の", "プライバシーポリシー", "をご覧ください。"]);
/** 2026-11-25 発注者の依頼で足した文言(compare・question だけ。ほかの案は見本のまま)。 */
const CONTACT_TEXTS = [
  "ご希望の連絡方法", "電話", "メール", "どちらでも", "メールアドレス（メールをご希望の方）",
  "連絡のつきやすい時間帯（任意）", "指定なし", "平日 10〜12時", "平日 12〜15時", "平日 15〜19時", "いつでも",
];
const ADDED_20261125: Record<LpDesignKey, Set<string>> = {
  base: new Set(), form: new Set(), editorial: new Set(),
  compare: new Set([
    ...CONTACT_TEXTS,
    "仲介と買取、両方の金額を2〜3営業日でお答えします。",
    "査定書は、ご家族の話し合いの材料としてお使いいただけます。",
    "お申込みのあと、平日 10:00〜19:00に担当者から1回お電話します。03-6823-2760からおかけします。メールをご希望の方には、メールでお送りします。",
  ]),
  question: new Set([
    ...CONTACT_TEXTS,
    "事情が複雑なので、相談しながら進めたい",
    "連絡先を入れるまで、当社からご連絡することはありません。",
    "お電話で直接ご相談:", "（平日 10:00〜19:00）",
    "ご事情があればお書きください（任意）",
    "お名前とお電話番号を、",
    // 査定書の見本(2026-11-25 発注者確認)
    "2〜3営業日で、このような査定書をお届けします。ご家族と話し合うための資料としてお使いいただけます。",
    "画像は見本です。",
  ]),
};

describe("公開名と見た目の対応表", () => {
  it("5つの公開名が5つの見た目に対応する", () => {
    expect(LP_DESIGN_BY_SLUG).toEqual({
      baikyaku: "base", "baikyaku-form": "form", "baikyaku-question": "question", "baikyaku-compare": "compare", "baikyaku-editorial": "editorial",
    });
    expect(lpDesignForSlug("baikyaku-form")).toBe("form");
    expect(lpDesignForSlug("souzoku")).toBeNull();
    expect(lpDesignForSlug("constructor")).toBeNull();
    expect(lpDesignForSlug("toString")).toBeNull();
  });
});

describe.each(LP_DESIGN_KEYS)("見た目 %s", (design) => {
  const html = renderLpDesignPage(design, input());

  it("見本の文言をそのまま出し、足さない", () => {
    const sample = readFileSync(join(SPEC, SAMPLE[design]), "utf8");
    const want = texts(sample).filter((t) => !SAMPLE_ONLY.has(t));
    const got = texts(html);
    const missing = [...new Set(want)].filter((t) => !got.includes(t));
    const added = [...new Set(got)].filter((t) => !want.includes(t) && !PROD_ONLY.has(t) && !ADDED_20261125[design].has(t));
    expect(missing).toEqual([]);
    expect(added).toEqual([]);
  });

  it("申込フォーム: 今の受け口・欄の名前・同意(必須)・ボット除け・注意の置き場", () => {
    expect(html).toContain('action="/lp/baikyaku/inquiry"');
    expect(html).toContain('method="post"');
    expect(html).toContain('data-inquiry="1"');
    expect(html).toContain('name="name"');
    expect(html).toContain('name="phone"');
    expect(html).toMatch(/<input type="checkbox" name="consent" value="yes" required>/);
    expect(html).toContain('name="hp_extra_note"');
    expect(html).toContain('class="inq-msg"');
    expect(html).toContain('data-err-for="consent"');
    expect(html).toContain(PRIVACY);
    expect(html).toContain('href="https://ligarejapan.com/privacypolicy/"');
    // 送信中・完了・エラーの表示は今の LP と同じ送信スクリプト(すべてのフォームに付ける)
    expect(html).toContain('querySelectorAll("form[data-inquiry]")');
    expect(html).toContain("lp:inquiry-done");
  });

  it("広告の印の隠し欄(値があるものだけ)", () => {
    const h = renderLpDesignPage(design, input({}, { adParams: { ...NO_AD, utmSource: "smartnews", utmCampaign: "c1", gclid: "G1" } }));
    expect(h).toContain('<input type="hidden" name="utm_source" value="smartnews">');
    expect(h).toContain('<input type="hidden" name="utm_campaign" value="c1">');
    expect(h).toContain('<input type="hidden" name="gclid" value="G1">');
    expect(h).not.toContain('name="utm_medium"');
  });

  it("外部の書体・画像・スクリプトを読まない(ロゴは自サイト)", () => {
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/src="(https?:)?\/\//i);
    expect(html).not.toMatch(/url\(/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/fonts\.googleapis|fonts\.gstatic|Shippori|Zen Kaku|Cormorant/);
    expect(html).toContain('src="/lp-assets/brand/logo-light.png"');
  });

  it("Google のタグは設定があるときだけ(今の公開ページと同じ)", () => {
    expect(html).not.toContain("googletagmanager");
    const h = renderLpDesignPage(design, input({}, { google: { tagId: "AW-1234", convLabel: "abcd1234" } }));
    expect(h).toContain('src="https://www.googletagmanager.com/gtag/js?id=AW-1234"');
    expect(h).toContain("send_to:'AW-1234/abcd1234'");
  });

  it("noindex・OG", () => {
    expect(html).toContain('<meta name="robots" content="noindex,nofollow">');
    expect(html).toContain('property="og:url" content="https://app.example.com/lp/baikyaku"');
  });

  it("</script> などを含む値を入れても壊れない", () => {
    const evil = `</script><script>alert(1)</script>"'<i id=x>`;
    const h = renderLpDesignPage(design, input(
      { headline: evil, company: { name: evil, contact: null, phone: null }, form: { action: "/lp/baikyaku/inquiry", privacyText: evil, disabled: false } },
      { adParams: { ...NO_AD, utmSource: evil } },
    ));
    expect(h).not.toContain("<script>alert(1)");
    expect(h).not.toContain("<i id=x>");
    expect(h).toContain("&lt;/script&gt;&lt;script&gt;alert(1)");
  });

  it("電話番号が無いときは電話の案内を出さない", () => {
    const h = renderLpDesignPage(design, input({ company: { name: null, contact: null, phone: null } }));
    expect(h).not.toContain("tel:");
    expect(h).toContain('<div class="one">');
    // 2026-11-25: 電話の文と導線も出さない
    expect(h).not.toContain("お電話で直接ご相談");
    expect(h).not.toContain("からおかけします");
    expect(h).not.toContain('class="s"');
  });

  it("下の固定バーの「電話」ボタンに番号を出す(2026-11-25)", () => {
    expect(html).toContain('<a class="s" href="tel:0368232760"><small>電話</small>03-6823-2760</a>');
  });

  it("連絡方法・時間帯の欄は compare・question だけ", () => {
    const asks = design === "compare" || design === "question";
    // スクリプトの中の欄の名前(送信スクリプトが読む)は除いて、画面の欄だけを見る
    const markup = html.replace(/<script[\s\S]*?<\/script>/g, "");
    for (const s of ['name="contactPref"', 'name="contactTime"', 'name="email"', 'data-either-email="1"']) {
      expect(markup.includes(s)).toBe(asks);
    }
  });
});

// 2026-11-25 発注者: compare・question の改善(連絡方法・時間帯)
describe("連絡方法・時間帯の欄(compare・question)", () => {
  it.each(["compare", "question"] as const)("%s: 既定は電話・メール欄・時間帯は選ぶだけ(任意)", (d) => {
    const h = renderLpDesignPage(d, input());
    expect(h).toContain('<input type="radio" name="contactPref" value="phone" checked>');
    expect(h).toContain('<input type="radio" name="contactPref" value="email">');
    expect(h).toContain('<input type="radio" name="contactPref" value="either">');
    expect(h).toMatch(/<input id="[a-z]*em" type="email" name="email" placeholder=" " autocomplete="email" maxlength="254">/);
    expect(h).toMatch(/<select id="[a-z]*ctm" name="contactTime"><option value="">指定なし<\/option><option>平日 10〜12時<\/option><option>平日 12〜15時<\/option><option>平日 15〜19時<\/option><option>いつでも<\/option><\/select>/);
    expect(h).toContain(`data-err-for="email"`);
    // 電話番号は必須のまま
    expect(h).toMatch(/type="tel" name="phone"[^>]*required/);
    // ページ内の id は重ならない(フォームが2つあるため)
    const ids = [...h.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  type Err = { f: string; m: string };
  const check = new Function(`return (${INQUIRY_CLIENT_CHECK_SOURCE})`)() as (v: Record<string, unknown>) => Err[];
  const base = { name: "架空 太郎", phone: "090-1234-5678", email: "", consent: true };
  it("画面内のチェック: メール・どちらでも(この2案)はメールアドレスが要る", () => {
    expect(check({ ...base, pref: "email", ee: true }).map((e) => e.f)).toEqual(["email"]);
    expect(check({ ...base, pref: "either", ee: true }).map((e) => e.f)).toEqual(["email"]);
    expect(check({ ...base, pref: "phone", ee: true })).toEqual([]);
    expect(check({ ...base, pref: "either", ee: true, email: "a@example.com" })).toEqual([]);
    // 今の LP・DM 用(印なし)は「どちらでも」でメールなしを今までどおり通す
    expect(check({ ...base, pref: "either" })).toEqual([]);
  });
  it("送信スクリプトはフォームの印(data-either-email)を読む", () => {
    const h = renderLpDesignPage("compare", input());
    expect(h).toContain('ee:f.getAttribute("data-either-email")==="1"');
  });
  it("受け口の検証: emailRequiredForEither のときは「どちらでも」でメールが要る・時間帯はそのまま保存", () => {
    const f = (o: Record<string, string>) => (k: string) => ({ name: "架空 太郎", phone: "090-1234-5678", consent: "yes", ...o } as Record<string, string>)[k] ?? null;
    expect(parseInquiryForm(f({ contactPref: "either" }), { emailRequiredForEither: true })).toEqual({ kind: "invalid", errors: ["email_required_for_pref"] });
    expect(parseInquiryForm(f({ contactPref: "email" }), { emailRequiredForEither: true })).toEqual({ kind: "invalid", errors: ["email_required_for_pref"] });
    expect(parseInquiryForm(f({ contactPref: "either" }))).toMatchObject({ kind: "ok" });
    expect(parseInquiryForm(f({ contactPref: "either", email: "a@example.com", contactTime: "平日 12〜15時" }), { emailRequiredForEither: true }))
      .toMatchObject({ kind: "ok", value: { contactPref: "either", email: "a@example.com", contactTime: "平日 12〜15時" } });
  });
  it("この印を付ける公開名は compare・question だけ", () => {
    expect(lpDesignAsksContactPref("baikyaku-compare")).toBe(true);
    expect(lpDesignAsksContactPref("baikyaku-question")).toBe(true);
    for (const s of ["baikyaku", "baikyaku-form", "baikyaku-editorial", "souzoku", "constructor"]) expect(lpDesignAsksContactPref(s)).toBe(false);
  });
});

describe("compare 案の文言(2026-11-25)", () => {
  const h = renderLpDesignPage("compare", input());
  it("冒頭の直下・ボタンの近く・フォームの直前", () => {
    expect(h).toContain("仲介と買取、両方の金額を2〜3営業日でお答えします。");
    const both = h.indexOf("両方の金額を無料で確かめる");
    const family = h.indexOf("査定書は、ご家族の話し合いの材料としてお使いいただけます。");
    expect(family).toBeGreaterThan(both);
    const call = h.indexOf("お申込みのあと、平日 10:00〜19:00に担当者から1回お電話します。03-6823-2760からおかけします。メールをご希望の方には、メールでお送りします。");
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(h.indexOf('id="form"'));
    // 冒頭の節の中
    expect(h.indexOf("仲介と買取、両方の金額を2〜3営業日でお答えします。")).toBeLessThan(h.indexOf("</section>"));
  });
  it("ほかの案には出さない", () => {
    for (const d of ["base", "form", "question", "editorial"] as const) {
      const o = renderLpDesignPage(d, input());
      expect(o).not.toContain("両方の金額を2〜3営業日でお答えします");
      expect(o).not.toContain("からおかけします");
      expect(o).not.toContain("ご家族の話し合いの材料として");
    }
  });
});

describe("question 案: 相談の分岐・安心の一言・電話・ご事情の欄(2026-11-25)", () => {
  const h = renderLpDesignPage("question", input());
  const compose = new Function(`return (${QUESTION_COMPOSE_SOURCE})`)() as (k: string, p: string, c: string, n?: string, cs?: boolean) => { message: string; propertyAddress: string };
  it("質問1に「相談しながら進めたい」を足す(選ぶと分岐)", () => {
    expect(h).toContain('data-qcs="事情が複雑なので、相談しながら進めたい"');
    expect(h.match(/class="tile"/g)?.length).toBe(9);
    expect(h).toContain('w.classList.toggle("cs",cs)');
  });
  it("相談を選んだら message はその選択だけ(種類・所在地・ご事情は入れない)", () => {
    expect(compose("戸建て", "東京都", "世田谷区", "書いた", true)).toEqual({ message: "ご希望: 事情が複雑なので、相談しながら進めたい", propertyAddress: "" });
  });
  it("ご事情の欄は答えの後ろに足す・上限に収める・受け口の検証を通る", () => {
    expect(compose("戸建て", "東京都", "世田谷区", " 兄弟で共有しています\r\n急ぎません ")).toEqual({
      message: "物件の種類: 戸建て\nご事情: 兄弟で共有しています\n急ぎません", propertyAddress: "東京都世田谷区",
    });
    expect(compose("", "", "", "だけ")).toEqual({ message: "ご事情: だけ", propertyAddress: "" });
    const long = compose("マンション", "", "", "あ".repeat(2000));
    expect([...long.message].length).toBe(1000);
    const r = parseInquiryForm((k) => ({ name: "架空 太郎", phone: "090-1234-5678", consent: "yes", ...long } as Record<string, string>)[k] ?? null);
    expect(r.kind).toBe("ok");
    // NFKC で伸びる文字(「…」→「...」)を詰めても、受け口の上限を超えない
    const dots = compose("戸建て", "", "", "…".repeat(900));
    expect([...dots.message].length).toBeLessThanOrEqual(1000);
    const r2 = parseInquiryForm((k) => ({ name: "架空 太郎", phone: "090-1234-5678", consent: "yes", ...dots } as Record<string, string>)[k] ?? null);
    expect(r2.kind).toBe("ok");
    // 欄は名前を持たない(そのままは送らない)・上限つき
    expect(h).toMatch(/<textarea id="wnt" data-q-note="1" maxlength="\d+" rows="4"><\/textarea>/);
    expect(h).toContain("ご事情があればお書きください（任意）");
  });
  it("質問1・2に「連絡先を入れるまで…」、各段に電話(番号と受付時間)", () => {
    expect(h.match(/連絡先を入れるまで、当社からご連絡することはありません。/g)?.length).toBe(2);
    const line = 'お電話で直接ご相談: <a href="tel:0368232760">03-6823-2760</a>（平日 10:00〜19:00）';
    // 質問1・質問2・ご事情の欄のすぐ下・相談の段
    expect(h.split(line).length - 1).toBe(4);
    const note = h.indexOf('data-q-note="1"');
    expect(h.indexOf(line, note)).toBeGreaterThan(note);
    expect(h.indexOf(line, note)).toBeLessThan(h.indexOf('name="name"', note));
  });
  it("連絡先の前に査定書の見本(画像は実在・見本と明記・相談の段では出さない)", () => {
    expect(existsSync(join(process.cwd(), "public", LP_SATEI_SAMPLE.src))).toBe(true);
    const img = h.indexOf(LP_SATEI_SAMPLE.src);
    expect(img).toBeGreaterThan(-1);
    expect(h.split(LP_SATEI_SAMPLE.src).length - 1).toBe(1);
    // 質問2の後・ご事情の欄とお届け先の欄より前、相談のときは隠れる .qn-only の中
    expect(img).toBeLessThan(h.indexOf('data-q-note="1"'));
    expect(img).toBeLessThan(h.indexOf('name="name"'));
    expect(h.lastIndexOf('class="qn-only"', img)).toBeGreaterThan(h.lastIndexOf('class="stp"', img));
    expect(h).toContain("2〜3営業日で、このような査定書をお届けします。ご家族と話し合うための資料としてお使いいただけます。");
    expect(h).toContain("画像は見本です。");
  });
});

describe("スクリプトが止まっても読める・動きを減らす設定", () => {
  const css = (LP_DESIGN_COMMON_CSS + Object.values(LP_DESIGN_EXTRA_CSS).join("")).replace(/\/\*[\s\S]*?\*\//g, "");
  it("現れる前に隠す・畳むのは html.rv(スクリプトが動く印)のときだけ", () => {
    // 隠す宣言は .rv で始まる規則の中だけにある
    const rules = css.replace(/@media[^{]*\{([\s\S]*?\})\s*\}/g, "$1").match(/[^{}]+\{[^{}]*\}/g) ?? [];
    const hiding = rules.filter((r) => /opacity:(0|\.16)[;}]|translateY\((108|22)|scaleX\(0\)|scaleY\(0\)|grid-template-rows:0fr|inset\(0 100% 0 0\)|inset\(0 0 0 100%\)|translateY\(110%\)|\.stp\{display:none/.test(r));
    expect(hiding.length).toBeGreaterThan(8);
    for (const r of hiding) {
      const sel = r.slice(0, r.indexOf("{")).trim();
      // keyframes の from は対象外(CSS だけで動き、最後は見える)
      if (/^from$/.test(sel)) continue;
      // ボタンの塗り・入力欄の下線(飾り・文字は隠さない)
      if (sel === ".cta::before" || sel === ".fld::after") continue;
      expect(sel.split(",").map((s) => s.trim()).filter((s) => !s.startsWith(".rv "))).toEqual([]);
    }
  });
  it("最初に印を付け、本体が動かなければ外す", () => {
    const h = renderLpDesignPage("base", input());
    const head = h.slice(0, h.indexOf("</head>"));
    expect(head).toContain('document.documentElement.classList.add("rv")');
    expect(head).toContain('classList.remove("rv")');
    expect(h).toContain("window.__lpDesignReady=1");
  });
  it("prefers-reduced-motion で動きを止める", () => {
    expect(css).toContain("@media (prefers-reduced-motion:reduce)");
    expect(css).toContain(".say span{opacity:1!important}");
  });
});

describe("question 案: 種類・都県・市区町村を message / propertyAddress に入れる", () => {
  const compose = new Function(`return (${QUESTION_COMPOSE_SOURCE})`)() as (k: string, p: string, c: string) => { message: string; propertyAddress: string };
  it("種類は message、都県+市区町村は propertyAddress", () => {
    expect(compose("戸建て", "東京都", "世田谷区")).toEqual({ message: "物件の種類: 戸建て", propertyAddress: "東京都世田谷区" });
    expect(compose("", "千葉県", "")).toEqual({ message: "", propertyAddress: "千葉県" });
    expect(compose("土地", "", " 横浜市 ")).toEqual({ message: "物件の種類: 土地", propertyAddress: "横浜市" });
    expect(compose("マンション", "神奈川県", "神奈川県川崎市")).toEqual({ message: "物件の種類: マンション", propertyAddress: "神奈川県川崎市" });
  });
  it("ページに隠し欄があり、受け口の検証を通る", () => {
    const h = renderLpDesignPage("question", input());
    expect(h).toContain('<input type="hidden" name="message" value="">');
    expect(h).toContain('<input type="hidden" name="propertyAddress" value="">');
    expect(h).toContain('data-qk="戸建て"');
    expect(h).toContain('data-qp="埼玉県"');
    // 市区町村の欄は名前を持たない(そのままは送らない)
    expect(h).toMatch(/<input id="wct" type="text" data-q-city="1"/);
    // 都県(最長4字)とつないでも所在地の上限(200字)に収まる
    expect(h).toContain('data-q-city="1" maxlength="196"');
    // 日本語入力の変換を確定する Enter では次の質問へ進まない
    expect(h).toContain("if(e.isComposing||e.keyCode===229)return;");
    const v = compose("戸建て", "埼玉県", "さいたま市");
    const form: Record<string, string> = { name: "架空 太郎", phone: "090-1234-5678", consent: "yes", ...v };
    const r = parseInquiryForm((k) => form[k] ?? null);
    expect(r).toMatchObject({ kind: "ok", value: { message: "物件の種類: 戸建て", propertyAddress: "埼玉県さいたま市" } });
  });
});

// 2026-11-24 発注者: 査定書はこの表の形式では作らない(査定では仲介と買取の両方の金額を伝える)=金額の表と注記を外す。
describe("compare 案: 金額の表を外す", () => {
  const h = renderLpDesignPage("compare", input());
  it("表の仮の金額と注記を出さない", () => {
    expect(h).not.toContain("○,○○○万円");
    expect(h).not.toContain("体裁の見本");
    expect(h).not.toContain('class="cmp');
    expect(LP_DESIGN_EXTRA_CSS.compare).not.toContain(".cmp");
  });
  it("新しい見出し(2行)と説明文・ボタンはそのまま", () => {
    expect(h).toContain('<h2 class="h2"><span class="m"><span>迷うときは、</span></span><span class="m"><span>両方の金額を聞いてから</span></span></h2>');
    expect(h).toContain("査定では、仲介で売る場合の金額と、買取の場合の金額の両方をお伝えします。比べてから、お決めください。");
    expect(h).not.toContain("両方の金額を並べて</span>");
    expect(h).toContain("両方の金額を無料で確かめる");
  });
  it.each(["base", "form", "question", "editorial"] as const)("ほかの案(%s)には compare 案の節が入らず、表の CSS も無い", (d) => {
    const o = renderLpDesignPage(d, input());
    expect(o).not.toContain("両方の金額を聞いてから");
    expect(o).not.toContain("両方の金額を無料で確かめる");
    expect(o).not.toContain(".cmp");
    // 仲介と買取の節(今のまま)
    expect(o).toContain("どちらもご案内できます。迷うときは、両方の金額を並べてお出しします。");
  });
});

describe("form 案: 冒頭と下の2つのフォーム", () => {
  it("2つとも今の受け口に送り、id が重ならない", () => {
    const h = renderLpDesignPage("form", input());
    expect(h.match(/data-inquiry="1"/g)?.length).toBe(2);
    const ids = [...h.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

it("濃い地用のロゴを public/lp-assets/brand に置いた", () => {
  expect(existsSync(join(process.cwd(), "public/lp-assets/brand/logo-light.png"))).toBe(true);
});

// ── 公開ページの読み込み ──
const cfg = loadSaleDmPublicPageConfig as unknown as ReturnType<typeof vi.fn>;
const CFG = {
  senderName: "株式会社リガーレジャパン", senderContact: "TEL 03-6823-2760",
  trackingBaseUrl: "https://app.example.com", lpPublicEnabled: true, privacyText: null,
  google: null as { tagId: string; convLabel: string | null } | null,
};
const scenario = (over: Record<string, unknown> = {}) => ({
  id: "s1", name: "売却", autoKey: null,
  lpHeadline: "売却の見出し", lpLead: null, lpBodyText: "■A\n本文", lpFaqJson: null, media: [],
  ...over,
});
const client = (row: unknown) => ({ dmScenario: { findFirst: vi.fn(async () => row) } });
const noQuery = () => null;

describe("loadPublicLpPage と見た目の対応表", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cfg.mockResolvedValue({ ...CFG });
  });
  it.each(Object.entries(LP_DESIGN_BY_SLUG))("対応表にある公開名 %s は新しい見た目(%s)", async (slug, design) => {
    const r = await loadPublicLpPage(client(scenario()) as never, slug, noQuery);
    expect(r.kind).toBe("page");
    if (r.kind !== "page") return;
    expect(r.html).toContain(`data-lp-design="${design}"`);
    expect(r.html).toContain(`action="/lp/${slug}/inquiry"`);
    expect(r.headers["Content-Security-Policy"]).toBe(LP_PAGE_HEADERS["Content-Security-Policy"]);
  });
  it("大文字の公開名も正規化してから引く", async () => {
    const r = await loadPublicLpPage(client(scenario()) as never, "BAIKYAKU-Compare", noQuery);
    expect(r.kind === "page" && r.html.includes('data-lp-design="compare"')).toBe(true);
  });
  it("対応表に無い公開名は今までの見た目", async () => {
    const r = await loadPublicLpPage(client(scenario()) as never, "souzoku", noQuery);
    expect(r.kind).toBe("page");
    if (r.kind !== "page") return;
    expect(r.html).not.toContain("data-lp-design");
    expect(r.html).toContain("売却の見出し");
  });
  it("公開ゲートが閉じていれば none(新しい見た目でも)", async () => {
    cfg.mockResolvedValue({ ...CFG, lpPublicEnabled: false });
    const c = client(scenario());
    expect(await loadPublicLpPage(c as never, "baikyaku", noQuery)).toEqual({ kind: "none" });
    expect(c.dmScenario.findFirst).not.toHaveBeenCalled();
  });
  it("「使う」でない・削除済み(行が見つからない)なら none", async () => {
    const c = client(null);
    expect(await loadPublicLpPage(c as never, "baikyaku-form", noQuery)).toEqual({ kind: "none" });
    expect(c.dmScenario.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { publicSlug: "baikyaku-form", deletedAt: null, active: true } }));
  });
  it("文章が無ければ none(中身の有無を漏らさない)", async () => {
    expect(await loadPublicLpPage(client(scenario({ lpBodyText: "  " })) as never, "baikyaku-question", noQuery)).toEqual({ kind: "none" });
    expect(await loadPublicLpPage(client(scenario({ lpHeadline: null })) as never, "baikyaku-editorial", noQuery)).toEqual({ kind: "none" });
  });
});
