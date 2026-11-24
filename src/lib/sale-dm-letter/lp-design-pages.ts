/**
 * 売却の代表LP 5つの見た目(比較テスト用・設計 docs/superpowers/specs/2026-11-24-lp-design-ab/README.md)。
 * React を使わない純関数。今の renderLpPage と同じ入力(LpRenderInput)から HTML を返す。
 *  - 文言は見本(同じフォルダの design-*.html・発注者確認済み)のものだけ。足さない・変えない。
 *    例外は今の LP と同じものを出す部分=個人情報の取り扱いの文面(設定)・申込の注意/完了の文言(送信スクリプト)・
 *    電話番号と会社名(差出人の設定)・所在地と免許番号と受付時間(lp-brand.ts)。
 *  - どの公開名でどの見た目を出すかは LP_DESIGN_BY_SLUG(比較テストのための仮の形。続けるなら種類ごとの列にする=migration は相談)。
 *  - 外部の読み込みなし(CSP は今の公開ページのまま)。書体は端末の明朝体・ゴシック体、ロゴは /lp-assets/brand/。
 *  - 申込フォームは今の受け口(POST /lp/<公開名>/inquiry)。欄の名前・同意・ボット除け・広告の印の隠し欄・
 *    送信中/完了/エラーの表示・Google のタグへの成果の送信は、今の LP と同じ部品(lp-page.ts)を使う。
 *  - スクロールで現れる部分は、スクリプトが動くとき(html.rv)だけ隠す。スクリプトが無い・止まったときは全部見える。
 *  - 動的な値はすべて escapeHtml。スクリプトはすべて固定の文字列(値を埋めない)。
 */
import { escapeHtml } from "./templates/index";
import { formatPhoneJp } from "../phone-format-jp";
import { LP_BRAND } from "./lp-brand";
import { HONEYPOT_FIELD, INQUIRY_LIMITS } from "./inquiry-input";
import { AD_HIDDEN_FIELDS, INQUIRY_SUBMIT_ALL_FORMS_SCRIPT, LP_CTA_LABEL, fieldError, googleTagScripts, ogMetaTags } from "./lp-page";
import type { LpFormInput, LpPublicInput, LpRenderInput } from "./lp-render-input";
import { LP_DESIGN_COMMON_CSS, LP_DESIGN_EXTRA_CSS } from "./lp-design-styles";

export type LpDesignKey = "base" | "form" | "question" | "compare" | "editorial";
export const LP_DESIGN_KEYS = ["base", "form", "question", "compare", "editorial"] as const satisfies readonly LpDesignKey[];

/** 公開名 → 見た目(2026-11-24 発注者了承の公開名)。ここに無い公開名は今までの見た目(renderLpPage)。 */
export const LP_DESIGN_BY_SLUG: Readonly<Record<string, LpDesignKey>> = Object.freeze({
  baikyaku: "base",
  "baikyaku-form": "form",
  "baikyaku-question": "question",
  "baikyaku-compare": "compare",
  "baikyaku-editorial": "editorial",
});

/** 正規化済みの公開名から見た目を引く(対応表に無ければ null・Object の既定の鍵は拾わない)。 */
export function lpDesignForSlug(slug: string): LpDesignKey | null {
  return Object.prototype.hasOwnProperty.call(LP_DESIGN_BY_SLUG, slug) ? LP_DESIGN_BY_SLUG[slug] : null;
}

/** 濃い地に載せるロゴ(文字を生成り色にした版・赤い丸はそのまま)。 */
export const LP_LOGO_LIGHT = { src: "/lp-assets/brand/logo-light.png", width: 560, height: 80, alt: "Ligare Japan" } as const;

/**
 * question 案の「種類・都県・市区町村」を、新しい列を作らずに今の欄へ入れる(ES5 の関数式の文字列・ブラウザで走る)。
 * 種類 → message、都県+市区町村 → propertyAddress。市区町村に都県から書いてあれば重ねない。
 */
export const QUESTION_COMPOSE_SOURCE = [
  "function(k,p,c){",
  'function t(s){return String(s==null?"":s).replace(/\\s+/g," ").replace(/^\\s+|\\s+$/g,"")}',
  "k=t(k);p=t(p);c=t(c);",
  'var a=p&&c.indexOf(p)===0?c:(p+c);',
  'return{message:k?"物件の種類: "+k:"",propertyAddress:a}}',
].join("");

/** 市区町村の欄の上限: いちばん長い都県名(4字)をつないでも所在地の上限に収まる長さ。 */
const CITY_MAX = INQUIRY_LIMITS.propertyAddress - 4;

interface Ctx {
  tel: { href: string; text: string } | null;
  form: LpFormInput | null;
  pub: LpPublicInput | null;
}

const arrow = `<span class="ar" aria-hidden="true"></span>`;
const ctaLink = (label: string, extra = "") => `<a class="cta${extra}" href="#apply"><span>${escapeHtml(label)}</span>${arrow}</a>`;

/** 見出しを1行ずつ下から出す(読み上げは aria-label の1文)。 */
function lines(cls: string, parts: string[], label: string, style = ""): string {
  return `<h1 class="${cls}"${style ? ` style="${style}"` : ""} aria-label="${escapeHtml(label)}">` +
    parts.map((p) => `<span class="m" aria-hidden="true"><span>${escapeHtml(p)}</span></span>`).join("") + `</h1>`;
}
function h2(parts: string[]): string {
  return `<h2 class="h2">${parts.map((p) => `<span class="m"><span>${escapeHtml(p)}</span></span>`).join("")}</h2>`;
}

const SKY = `<div class="sky" id="sky" aria-hidden="true"><svg viewBox="0 0 390 300" preserveAspectRatio="xMidYMax meet">` +
  `<circle class="thin s5" pathLength="1" cx="318" cy="62" r="26"/>` +
  `<path class="s1" pathLength="1" d="M-10 262 H400"/>` +
  `<path class="s2" pathLength="1" d="M34 262 V176 L92 128 L150 176 V262"/>` +
  `<path class="s3" pathLength="1" d="M22 180 L92 120 L162 180"/>` +
  `<path class="s4 thin" pathLength="1" d="M78 262 V214 H106 V262 M118 192 H138 V214 H118 Z M48 192 H68 V214 H48 Z"/>` +
  `<path class="s2" pathLength="1" d="M196 262 V70 H292 V262"/>` +
  `<path class="s4 thin" pathLength="1" d="M196 110 H292 M196 150 H292 M196 190 H292 M196 230 H292 M228 70 V262 M260 70 V262"/>` +
  `<path class="s3" pathLength="1" d="M186 70 H302 M204 70 V56 H284 V70"/>` +
  `<path class="s3" pathLength="1" d="M312 262 V150 H372 V262 M312 150 L342 128 L372 150"/>` +
  `<path class="s5 thin" pathLength="1" d="M326 172 H340 V192 H326 Z M348 172 H362 V192 H348 Z M334 262 V226 H352 V262"/>` +
  `<path class="s5" pathLength="1" d="M172 262 V214 M157 200 a15 18 0 1 0 30 0 a15 18 0 1 0 -30 0"/>` +
  `<path class="s6 thin" pathLength="1" d="M8 262 V236 M0 226 a8 10 0 1 0 16 0 a8 10 0 1 0 -16 0 M384 262 V240"/>` +
  `</svg></div><div class="veil"></div>`;

const SCROLLCUE = (cls: string, style = "") => `<div class="scrollcue${cls}" aria-hidden="true"${style ? ` style="${style}"` : ""}><b></b>Scroll</div>`;
const KICKER = `<p class="kicker f">不動産の売却</p>`;

// ── 申込フォーム(今の受け口・今の LP と同じ部品) ──

/** フォームの中身(お名前・電話・隠し欄・同意・注意の置き場)。id は1ページに2つあっても重ならないよう前置きを付ける。 */
function formFields(ctx: Ctx, idp: string, form: LpFormInput): string {
  const privacy = escapeHtml(form.privacyText).replace(/\n/g, "<br>");
  const ad = ctx.pub
    ? AD_HIDDEN_FIELDS.map(([field, name]) => {
        const v = ctx.pub!.adParams[field];
        return v ? `<input type="hidden" name="${name}" value="${escapeHtml(v)}">` : "";
      }).join("")
    : "";
  return `<div class="fld"><input id="${idp}nm" type="text" name="name" placeholder=" " autocomplete="name" required maxlength="${INQUIRY_LIMITS.name}"><label for="${idp}nm">お名前</label></div>${fieldError("name")}` +
    `<div class="fld"><input id="${idp}tl" type="tel" name="phone" placeholder=" " autocomplete="tel" inputmode="tel" required maxlength="${INQUIRY_LIMITS.phone}"><label for="${idp}tl">電話番号</label></div>${fieldError("phone")}` +
    ad +
    `<div class="hp" aria-hidden="true"><label>この欄は空のままにしてください<input name="${HONEYPOT_FIELD}" type="text" tabindex="-1" autocomplete="off"></label></div>` +
    `<details class="pv"><summary>個人情報の取り扱いについて</summary><p>${privacy}<br>詳しくは当社の<a href="${escapeHtml(LP_BRAND.privacyPolicyUrl)}" target="_blank" rel="noopener">プライバシーポリシー</a>をご覧ください。</p></details>` +
    `<label class="consent"><input type="checkbox" name="consent" value="yes" required><span>個人情報の取り扱いに同意する</span></label>${fieldError("consent")}` +
    `<div class="inq-msg" role="alert" aria-live="assertive" hidden></div>`;
}

function formOpen(form: LpFormInput, cls: string, style = "", id = ""): string {
  return `<form class="${cls}"${id ? ` id="${id}"` : ""} method="post" action="${escapeHtml(form.action)}" data-inquiry="1" novalidate${style ? ` style="${style}"` : ""}>`;
}
const submit = (style: string) => `<button class="cta" type="submit" style="${style}"><span>${escapeHtml(LP_CTA_LABEL)}</span>${arrow}</button>`;

// ── 冒頭(案ごと) ──

function heroBase(): string {
  return `<section class="hero dark" id="hero">${SKY}<div class="wrap" data-rv>${KICKER}` +
    lines("h1", ["その不動産、", "いくらなら", "買い手がつくか。"], "その不動産、いくらなら買い手がつくか。") +
    `<p class="lede f d3">住み替え、相続、空き家、資産の整理。ご事情は問いません。売ると決める前の段階から、ご相談いただけます。</p>` +
    ctaLink(LP_CTA_LABEL, " f d4") + SCROLLCUE(" f d4") + `</div></section>`;
}

function heroForm(ctx: Ctx): string {
  const form = ctx.form
    ? formOpen(ctx.form, "form f d3", "margin-top:28px;gap:22px") + formFields(ctx, "h", ctx.form) + submit("margin-top:4px") +
      `<p class="note" style="margin-top:-8px">入力はこの2つだけです。しつこい電話はしません。</p></form>`
    : "";
  return `<section class="hero dark" id="hero" style="justify-content:flex-start;padding-top:calc(64px + min(25svh,210px) + 30px)">${SKY}<div class="wrap" data-rv>${KICKER}` +
    lines("h1", ["いくらなら売れるか、", "2〜3営業日で", "お答えします"], "いくらなら売れるか、2〜3営業日でお答えします", "font-size:clamp(26px,8vw,40px)") +
    form + `</div></section>`;
}

function heroQuestion(ctx: Ctx): string {
  const tile = (attr: string, v: string, small: string | null, style = "") =>
    `<button type="button" class="tile" aria-pressed="false" ${attr}="${escapeHtml(v)}"${style ? ` style="${style}"` : ""}><b>${escapeHtml(v)}</b>${small ? `<small>${escapeHtml(small)}</small>` : ""}</button>`;
  const step3 = ctx.form
    ? `<div class="stp"><h2 class="qh">査定書のお届け先を、<br>教えてください</h2><div class="form" style="margin-top:22px;gap:22px">` +
      formFields(ctx, "w", ctx.form) +
      `<input type="hidden" name="message" value=""><input type="hidden" name="propertyAddress" value="">` +
      `</div>${submit("")}<p class="note">査定書は2〜3営業日でお届けします。しつこい電話はしません。</p></div>`
    : "";
  const body = `<div class="stp on"><h1 class="qh">売却を考えているのは、<br><span class="nb">どのような不動産ですか？</span></h1><div class="tiles">` +
    tile("data-qk", "戸建て", "土地つきの家") + tile("data-qk", "マンション", "1室・区分") + tile("data-qk", "土地", "更地・駐車場など") + tile("data-qk", "そのほか", "アパート・ビルなど") +
    `</div><p class="note" style="text-align:left;margin-top:18px">選ぶと、次の質問へ進みます。</p></div>` +
    `<div class="stp"><h2 class="qh">その不動産は、<br>どちらにありますか？</h2><div class="tiles">` +
    ["東京都", "神奈川県", "埼玉県", "千葉県"].map((p) => tile("data-qp", p, null, "min-height:62px")).join("") +
    `</div><div class="fld" style="margin-top:22px"><input id="wct" type="text" data-q-city="1" maxlength="${CITY_MAX}" placeholder=" "><label for="wct">市区町村（任意）</label></div>` +
    `<button class="cta nx" type="button"><span>次の質問へ進む</span>${arrow}</button></div>` +
    step3 + `<button type="button" class="back" hidden>前の質問に戻る</button>`;
  const open = ctx.form ? formOpen(ctx.form, "f d1", "", "wz") : `<div id="wz" class="f d1">`;
  return `<section class="hero dark" id="hero" style="justify-content:flex-start;padding-top:calc(64px + min(25svh,210px) + 44px)">${SKY}<div class="wrap" data-rv>` +
    `<div class="prog f"><span id="pgt">質問 一／三</span><span>残り1分ほど</span></div><div class="pl f"><b id="pgb"></b></div>` +
    open + body + (ctx.form ? `</form>` : `</div>`) + `</div></section>`;
}

function heroCompare(): string {
  return `<section class="hero dark" id="hero">${SKY}<div class="wrap" data-rv>${KICKER}` +
    lines("h1", ["不動産の売り方は、", "二つあります"], "不動産の売り方は、二つあります") +
    `<p class="lede f d3">どちらが合うかは、何を優先するかで決まります。当社はどちらもご案内できます。</p>` +
    SCROLLCUE(" f d4") + `</div></section>`;
}

function heroEditorial(): string {
  return `<section class="hero dark vhero" id="hero"><div class="wrap vh">` +
    `<h1 class="vt" aria-label="売るか、持つか。決めるのは、価格を知ってから。"><span class="vc" aria-hidden="true">売るか、持つか。</span><span class="vc" aria-hidden="true">決めるのは、</span><span class="vc" aria-hidden="true">価格を知ってから。</span></h1>` +
    `<div class="vside"><i class="vr" aria-hidden="true"></i><p>住み替え、相続、空き家、資産の整理。ご事情は問いません。</p>${SCROLLCUE("", "margin-top:6px")}</div>` +
    `</div></section>`;
}

// ── 下半分の節(5案で共通) ──

const MARQUEE_WORDS = ["住み替え", "相続", "空き家", "資産の整理", "戸建て", "マンション", "土地"];
function marquee(): string {
  const once = MARQUEE_WORDS.map((w) => `<span>${w}</span><span>/</span>`).join("");
  return `<div class="mq dark" id="mq"><div class="track" aria-hidden="true">${once}${once}</div><button class="mqbtn" id="mqbtn" type="button" aria-pressed="false">止める</button></div>`;
}

const SAY_WORDS = ["相場より高い", "査定額を", "お見せして、", "ご依頼を", "いただくことは", "しません。", "近くで実際に", "売れた事例を", "もとに、", "いくらなら", "買い手が", "つくかを、", "根拠と一緒に", "お伝えします。"];
function say(): string {
  return `<section class="sec light"><div class="wrap"><div class="rule" data-rv></div>` +
    `<p class="say" id="say" aria-label="${SAY_WORDS.join("")}">${SAY_WORDS.map((w) => `<span aria-hidden="true">${w}</span>`).join("")}</p></div></section>`;
}

function ways(): string {
  const way = (no: string, title: string, text: string, svg: string) =>
    `<article class="way"><div class="no">${no}</div><h3>${title}</h3><p>${text}</p><svg viewBox="0 0 54 54" aria-hidden="true">${svg}</svg></article>`;
  return `<section class="sec dark" style="padding-bottom:70px"><div class="wrap" data-rv><div class="rule"></div>` + h2(["売る、だけが", "答えではありません"]) +
    `<p class="lede f d2">売る・貸す・しばらく持つ・住み続けて売る。それぞれを選んだときの金額や手間の見通しを並べてお伝えします。横にめくってご覧ください。</p></div>` +
    `<div class="ways" id="ways">` +
    way("01", "売る", "今の価格の目安と、手元に残る金額の見込みをお伝えします。", `<path d="M8 26 L27 10 L46 26 M13 23 V44 H41 V23 M23 44 V32 H31 V44"/>`) +
    way("02", "貸す", "貸したときの家賃の目安や、かかる手間もご説明します。", `<circle cx="19" cy="27" r="9"/><path d="M28 27 H46 M40 27 V34 M46 27 V32"/>`) +
    way("03", "しばらく持つ", "持ち続けるときの費用と、気をつけたい期限を整理します。", `<circle cx="27" cy="27" r="18"/><path d="M27 15 V27 L35 32"/>`) +
    way("04", "住み続けて売る", "自宅を売った後も、そのまま住み続けられる方法（リースバック）もご案内します。", `<path d="M8 26 L27 10 L46 26 M13 23 V44 H41 V23"/><path d="M21 34 a6 6 0 0 1 12 0 M27 28 V25"/>`) +
    `</div><div class="dots" id="dots" aria-hidden="true"><i class="on"></i><i></i><i></i><i></i></div></section>`;
}

const PANES = `<div class="pane a wipe"><small>価格を重視したい方</small><h3>仲介で売る</h3><p>広く買主を探します。他社からの購入希望もすべてお伝えし、情報を抱え込むことはしません。</p><p class="c">買主が決まるまで、時間がかかることがあります。</p></div>` +
  `<div class="pane b wipe r"><small>早く確実に売りたい方</small><h3>買取で売る</h3><p>当社が直接買い取るほか、ご希望に応じて複数の買取会社もご紹介し、価格を並べてお見せします。荷物が残ったままでも構いません。</p><p class="c">一般に、仲介より価格は低くなります。</p></div>`;

function duo(): string {
  return `<section class="sec light"><div class="wrap"><div data-rv><div class="rule"></div>` + h2(["売り方は、", "仲介と買取の二つ"]) +
    `<p class="lede f d2">どちらもご案内できます。迷うときは、両方の金額を並べてお出しします。</p></div>` +
    `<div class="duo" data-rv>${PANES}</div></div></section>`;
}

function duoDark(): string {
  return `<section class="sec dark" style="padding-top:26px"><div class="wrap"><div class="duo dk" data-rv style="margin-top:0">${PANES}</div></div></section>`;
}

/** compare 案の「両方の金額」の節。金額の表は置かない(2026-11-24 発注者: 査定書はこの表の形式では作らない・査定では仲介と買取の両方の金額を伝える)。 */
function compareBoth(): string {
  return `<section class="sec light"><div class="wrap"><div data-rv><div class="rule"></div>` + h2(["迷うときは、", "両方の金額を聞いてから"]) +
    `<p class="lede f d2">査定では、仲介で売る場合の金額と、買取の場合の金額の両方をお伝えします。比べてから、お決めください。</p></div>` +
    ctaLink("両方の金額を無料で確かめる") + `</div></section>`;
}

function chapters(): string {
  const ch = (no: string, head: string[], text: string, cta = "") =>
    `<div class="ch" data-rv><div class="rule"></div><p class="chno f">${no}</p>${h2(head)}<p class="lede mn f d2">${text}</p>${cta}</div>`;
  return `<section class="sec light"><div class="wrap">` +
    ch("一", ["高い査定額は、", "お出ししません"], "相場より高い金額を見せられて依頼し、あとから値下げを重ねる。そうした売り方を、当社はしません。お伝えするのは「いくらなら買い手がつくか」です。近くで実際に売れた事例をもとに、根拠を書面でお渡しします。") +
    ch("二", ["買いたい人の声は、", "すべて届けます"], "他社から届いた購入の希望も、すべて売主さまにお伝えします。情報を抱え込んで、機会を減らすことはしません。") +
    ch("三", ["決めるのは、", "結果を見てから"], "査定とご相談は無料です。売るかどうかは、査定書をご覧になってからお決めください。しつこい電話はしません。", ctaLink(LP_CTA_LABEL, " f d3")) +
    `</div></section>`;
}

function flow(): string {
  const step = (no: string, title: string, text: string) => `<div class="step"><em>${no}</em><h3>${title}</h3><p>${text}</p></div>`;
  return `<section class="sec dark"><div class="wrap"><div data-rv><div class="rule"></div>` + h2(["お引き渡しまで、", "五つの段階"]) +
    `<p class="lede f d2">ご相談からお引き渡しまで、3〜6か月ほどが目安です。途中でやめても構いません。</p></div>` +
    `<div class="flow" id="flow"><div class="rail"><i id="rail"></i></div>` +
    step("01", "ご相談・無料査定", "机上の査定は2〜3営業日。現地の確認が必要な場合は1週間ほどで、査定書をお届けします。") +
    step("02", "ご家族での話し合い", "査定の結果を材料に、売るかどうかを決めていただきます。急かしません。") +
    step("03", "販売のご依頼", "売ると決めた場合に、販売をお任せいただく契約を結びます。") +
    step("04", "販売活動・ご契約", "買主を探し、条件がまとまれば売買契約を結びます。") +
    step("05", "お引き渡し", "代金を受け取り、鍵をお渡しして完了です。") +
    `</div></div></section>`;
}

const CASES: Array<[string, string, string]> = [
  ["神奈川県・マンション・築30年", "売買契約の直前まで買い手を探しご希望より高い価格で売却", "早く売りたいとのご依頼でした。ご希望の価格で購入を考える方が見つかりましたが、売買契約の直前まで、より良い条件の買い手を探し続けました。その結果、ご希望を上回る価格で購入される方が見つかり、売却にかかる諸費用やお引っ越しの費用もまかなうことができました。"],
  ["世田谷区・戸建て・築35年", "権利書も見つからない状態から相続税の申告期限までに売却", "相続人であるお子様たちはすでにそれぞれ家を所有しているため、売却のご相談をいただきました。不動産の権利書も見つからず、何から手を付けてよいか分からないという状況から始まりましたが、遺産の分割協議と並行して、納税計画、あわせて不動産の調査も進めさせていただきました。相続税の申告期限までに無事売却も完了し、ご兄弟でご両親の遺産を確実に受け継いでいただくことができました。"],
  ["埼玉県・戸建て・築20年", "リースバックで住み続けながら資金を用意し数年後にご自宅を買い戻し", "ご家族でお住まいのご自宅について、ご事情によりまとまった資金が必要になったとのご相談でした。ご自宅は相続されたもので借り入れは残っていませんでしたが、学校やお仕事の関係で、すぐに引っ越すことはできない状況でした。金融機関のリバースモーゲージも検討されましたが、金融機関の評価と市場の相場に開きがあり、必要な金額を一度に借りることはできなかったそうです。そこで当社から、リースバックをご提案しました。必要な資金を上回る評価が出たため、リースバック事業者と交渉し、売買価格を抑える代わりに家賃を下げていただきました。数年間賃貸でお住まいになった後、買い戻しの資金が整い、ご自宅を無事に買い戻されました。ご家族は一度も引っ越すことなく元の暮らしに戻られ、大変喜んでいただけました。"],
];
function cases(): string {
  return `<section class="sec light"><div class="wrap"><div data-rv><div class="rule"></div>` + h2(["これまでの", "ご相談から"]) + `</div><div class="cases">` +
    CASES.map(([where, title, text]) =>
      `<article class="case f" data-rv><small>${where}</small><h3>${title}</h3><div class="body"><div><p>${text}</p></div></div>` +
      `<button class="more" type="button" aria-expanded="false"><i aria-hidden="true"></i><span>続きを読む</span></button></article>`).join("") +
    `</div></div></section>`;
}

const FAQ: Array<[string, string]> = [
  ["相談したら、必ず売らないといけませんか？", "いいえ。査定の結果を見てから、売るかどうかをお決めいただけます。売却をしつこくお勧めすることはありません。"],
  ["査定に費用はかかりますか？", "かかりません。査定もご相談も無料です。"],
  ["住宅ローンが残っていても売れますか？", "売れた代金などでローンを完済できれば、売却できます。残っている金額と査定額を見比べて、見通しをお伝えします。"],
  ["住みながら売ることはできますか？", "できます。お住まいのまま販売を進め、引き渡しの時期はご都合をうかがって決めていきます。"],
  ["荷物が残ったままでも大丈夫ですか？", "大丈夫です。空き家の場合は、家具や荷物が残ったままの状態で査定できます。片付けの進め方もあわせてご案内します。"],
  ["どの地域の不動産を相談できますか？", "東京都・神奈川県・埼玉県・千葉県の一都三県の不動産を承っています。"],
];
function faq(): string {
  return `<section class="sec dark"><div class="wrap"><div data-rv><div class="rule"></div>` + h2(["よくあるご質問"]) + `</div><div class="faq" id="faq">` +
    FAQ.map(([q, a], i) =>
      `<div class="q${i === 0 ? " open" : ""}"><button type="button" aria-expanded="${i === 0}">${q}<span class="x" aria-hidden="true"></span></button><div class="a"><div><p>${a}</p></div></div></div>`).join("") +
    `</div></div></section>`;
}

function apply(ctx: Ctx): string {
  const form = ctx.form ? formOpen(ctx.form, "form", "", "form") + formFields(ctx, "", ctx.form) + submit("margin-top:6px") + `</form>` : "";
  const tel = ctx.tel
    ? `<div style="margin-top:56px;text-align:center" data-rv class="f"><p style="font-family:var(--mincho);letter-spacing:.2em;font-size:14px">お電話でのご相談</p>` +
      `<a class="telbig" href="${ctx.tel.href}">${escapeHtml(ctx.tel.text)}</a><p class="note" style="margin-top:6px">${escapeHtml(LP_BRAND.phoneHours)}</p></div>`
    : "";
  return `<section class="sec light" id="apply"><div class="wrap"><div data-rv><div class="rule"></div>` + h2(["無料査定の", "お申し込み"]) +
    `<p class="lede f d2">お名前と電話番号だけでお送りいただけます。査定・ご相談は無料で、売却を前提にしません。しつこい電話はしません。</p></div>` +
    form + tel + `</div></section>`;
}

const ORDER: Record<LpDesignKey, (ctx: Ctx) => string[]> = {
  base: (c) => [heroBase(), marquee(), say(), ways(), duo(), flow(), cases(), faq(), apply(c)],
  form: (c) => [heroForm(c), marquee(), say(), ways(), duo(), flow(), cases(), faq(), apply(c)],
  question: (c) => [heroQuestion(c), marquee(), say(), ways(), duo(), flow(), cases(), faq(), apply(c)],
  compare: (c) => [heroCompare(), duoDark(), compareBoth(), ways(), say(), flow(), cases(), faq(), apply(c)],
  editorial: (c) => [heroEditorial(), marquee(), chapters(), ways(), duo(), flow(), cases(), faq(), apply(c)],
};

/**
 * 最初に読む一言: スクリプトが動く印(html.rv)を付ける。本体のスクリプトが4秒たっても動き出さなければ(読み込みや実行の失敗)、
 * 印を外して全部見せる(スクロールで現れる部分を隠したままにしない)。
 */
const RV_HEAD_SCRIPT = 'document.documentElement.classList.add("rv");setTimeout(function(){if(!window.__lpDesignReady){document.documentElement.classList.remove("rv")}},4000);';

/**
 * 動き(見本のスクリプトを写し、無い部品でも止まらないようにしたもの・固定の文字列)。
 *  - 画面に入った部品に .in。IntersectionObserver が無ければ全部出す。8秒操作が無ければ全部出す(スクロールしない撮影・巡回でも読める)。
 *  - 「動きを減らす」設定ではスクロールに連動する動きをしない(文言はすべて見える)。
 *  - 途中で失敗したら印(rv)を外して全部見せる。
 */
const MOTION_SCRIPT = [
  "(function(){var root=document.documentElement;try{",
  'var reduce=window.matchMedia?window.matchMedia("(prefers-reduced-motion: reduce)"):{matches:true};',
  "var $=function(s,r){return(r||document).querySelector(s)},$$=function(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s))};",
  'function reveal(el){el.classList.add("in");$$(".m,.f,.rule,.wipe",el).forEach(function(c){c.classList.add("in")})}',
  'var targets=$$("[data-rv]");',
  'if("IntersectionObserver" in window){var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){reveal(e.target);io.unobserve(e.target)}})},{threshold:.18,rootMargin:"0px 0px -6% 0px"});targets.forEach(function(t){io.observe(t)})}else{targets.forEach(reveal)}',
  'var acted=false;["scroll","pointerdown","keydown","wheel","touchstart"].forEach(function(ev){window.addEventListener(ev,function(){acted=true},{passive:true,once:true})});',
  "setTimeout(function(){if(!acted){targets.forEach(reveal)}},8000);",
  'var top=$("#top"),bar=$("#bar"),hero=$("#hero"),sky=$("#sky"),say=$("#say"),words=say?$$("span",say):[],flow=$("#flow"),rail=$("#rail"),steps=flow?$$(".step",flow):[],apply=$("#apply"),ticking=false;',
  "function prog(el,a,b){var r=el.getBoundingClientRect(),vh=window.innerHeight;return Math.max(0,Math.min(1,(vh*a-r.top)/(r.height+vh*(a-b))))}",
  "function frame(){ticking=false;var y=window.scrollY||window.pageYOffset||0,vh=window.innerHeight,hh=hero?hero.offsetHeight:0;",
  'if(top){top.classList.toggle("solid",y>24)}',
  'if(bar){var near=false;if(apply){var ar=apply.getBoundingClientRect();near=ar.top<vh*.75&&ar.bottom>vh*.3}bar.classList.toggle("show",y>hh*.7&&!near)}',
  "if(reduce.matches)return;",
  'if(sky&&y<hh){sky.style.transform="translate3d(0,"+(y*.22).toFixed(1)+"px,0)";sky.style.opacity=String(Math.max(0,1-y/(hh*.75)))}',
  'if(say){var p=prog(say,.82,.38),n=Math.round(p*words.length);for(var i=0;i<words.length;i++){words[i].classList.toggle("on",i<n)}}',
  'if(flow&&rail){var fp=prog(flow,.72,.45);rail.style.transform="scaleY("+fp.toFixed(3)+")";for(var j=0;j<steps.length;j++){steps[j].classList.toggle("on",fp>=j/(steps.length-1)-.02)}}}',
  "function onScroll(){if(!ticking){ticking=true;requestAnimationFrame(frame)}}",
  'window.addEventListener("scroll",onScroll,{passive:true});window.addEventListener("resize",onScroll);frame();',
  'if(reduce.matches){words.forEach(function(w){w.classList.add("on")});steps.forEach(function(s){s.classList.add("on")})}',
  'var ways=$("#ways"),dots=$$("#dots i"),cards=ways?$$(".way",ways):[];',
  'if(ways){ways.addEventListener("scroll",function(){var c=ways.scrollLeft+ways.clientWidth/2,best=0,bd=1e9;cards.forEach(function(el,i){var d=Math.abs(el.offsetLeft+el.offsetWidth/2-c);if(d<bd){bd=d;best=i}});dots.forEach(function(d,i){d.classList.toggle("on",i===best)})},{passive:true})}',
  'var mq=$("#mq"),mb=$("#mqbtn");if(mq&&mb){mb.addEventListener("click",function(){var p=mq.classList.toggle("paused");mb.setAttribute("aria-pressed",String(p));mb.textContent=p?"動かす":"止める"})}',
  '$$("#faq .q").forEach(function(q){var b=$("button",q);if(b){b.addEventListener("click",function(){var o=q.classList.toggle("open");b.setAttribute("aria-expanded",String(o))})}});',
  '$$(".case").forEach(function(c){var b=$(".more",c);if(b){b.addEventListener("click",function(){var o=c.classList.toggle("open");b.setAttribute("aria-expanded",String(o));var s=$("span",b);if(s){s.textContent=o?"閉じる":"続きを読む"}})}});',
  '$$(".cta").forEach(function(c){c.addEventListener("touchstart",function(){c.classList.add("fill")},{passive:true});c.addEventListener("touchend",function(){setTimeout(function(){c.classList.remove("fill")},380)})});',
  "window.__lpDesignReady=1;",
  '}catch(_){root.classList.remove("rv")}})();',
].join("");

/**
 * question 案の3つの質問(見本のスクリプト+選んだ答えを今の欄 message / propertyAddress に写す・固定の文字列)。
 * 市区町村の欄で Enter を押しても送信しない(お名前・電話の欄はまだ見えていない)=次の質問へ進む。
 * 日本語入力の変換を確定する Enter(isComposing / keyCode 229)では進まない。
 */
const QUESTION_SCRIPT = [
  '(function(){var w=document.getElementById("wz");if(!w)return;try{',
  `var CP=${QUESTION_COMPOSE_SOURCE};`,
  'var s=0,A=function(l){return Array.prototype.slice.call(l)},st=A(w.querySelectorAll(".stp")),pb=document.getElementById("pgb"),pt=document.getElementById("pgt"),bk=w.querySelector(".back"),nm=["一","二","三"];',
  'var kind="",pref="",city=w.querySelector("[data-q-city]");',
  'function sync(){var v=CP(kind,pref,city?city.value:"");var m=w.querySelector("input[name=message]"),a=w.querySelector("input[name=propertyAddress]");if(m){m.value=v.message}if(a){a.value=v.propertyAddress}}',
  'function go(n){s=n;st.forEach(function(e,i){e.classList.toggle("on",i===n)});if(pb){pb.style.transform="scaleX("+((n+1)/3).toFixed(4)+")"}if(pt){pt.textContent="質問 "+nm[n]+"／三"}if(bk){bk.hidden=n===0}}',
  'st.forEach(function(e,i){var ts=A(e.querySelectorAll(".tile"));ts.forEach(function(t){t.addEventListener("click",function(){ts.forEach(function(o){o.setAttribute("aria-pressed",String(o===t))});',
  'if(t.hasAttribute("data-qk")){kind=t.getAttribute("data-qk")}if(t.hasAttribute("data-qp")){pref=t.getAttribute("data-qp")}sync();if(i===0){setTimeout(function(){go(1)},380)}})})});',
  'if(city){city.addEventListener("input",sync);city.addEventListener("keydown",function(e){if(e.isComposing||e.keyCode===229)return;if(e.key==="Enter"||e.keyCode===13){e.preventDefault();sync();go(Math.min(st.length-1,s+1))}})}',
  'A(w.querySelectorAll(".nx")).forEach(function(b){b.addEventListener("click",function(){sync();go(Math.min(st.length-1,s+1))})});',
  'if(bk){bk.addEventListener("click",function(){go(Math.max(0,s-1))})}',
  '}catch(_){document.documentElement.classList.remove("rv")}})();',
].join("");

export function renderLpDesignPage(design: LpDesignKey, input: LpRenderInput): string {
  const phone = input.company.phone;
  const ctx: Ctx = {
    tel: phone ? { href: `tel:${escapeHtml(phone)}`, text: formatPhoneJp(phone).value } : null,
    form: input.form && !input.form.disabled ? input.form : null,
    pub: input.mode === "public" ? (input.public ?? null) : null,
  };
  const logo = (style = "") =>
    `<img class="logo" src="${LP_LOGO_LIGHT.src}" alt="${LP_LOGO_LIGHT.alt}" width="${LP_LOGO_LIGHT.width}" height="${LP_LOGO_LIGHT.height}"${style ? ` style="${style}"` : ""}>`;
  const header = `<header class="top" id="top"><div class="wrap">${logo()}${ctx.tel ? `<a class="toptel" href="${ctx.tel.href}">${escapeHtml(ctx.tel.text)}</a>` : ""}</div></header>`;
  const footer = `<footer class="foot dark"><div class="wrap">${logo("height:26px;margin-bottom:14px")}` +
    (input.company.name ? `${escapeHtml(input.company.name)}<br>` : "") +
    `${escapeHtml(LP_BRAND.address)}<br>${escapeHtml(LP_BRAND.license)}</div></footer>`;
  const bar = `<div class="bar" id="bar"><div${ctx.tel ? "" : ` class="one"`}><a class="p" href="#apply">${escapeHtml(LP_CTA_LABEL)}</a>` +
    (ctx.tel ? `<a class="s" href="${ctx.tel.href}">電話</a>` : "") + `</div></div>`;
  const ogMeta = ctx.pub ? ogMetaTags(input, ctx.pub) : "";
  const googleTag = ctx.pub?.google ? googleTagScripts(ctx.pub.google, ctx.pub.safeQuery) : "";
  const css = LP_DESIGN_COMMON_CSS + "\n" + LP_DESIGN_EXTRA_CSS[design];
  const scripts = `<script>${MOTION_SCRIPT}</script>` +
    (design === "question" ? `<script>${QUESTION_SCRIPT}</script>` : "") +
    (ctx.form ? `<script>${INQUIRY_SUBMIT_ALL_FORMS_SCRIPT}</script>` : "");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">` +
    `<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="strict-origin"><title>${escapeHtml(input.headline)}</title>${ogMeta}` +
    `<style>body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style><style>${css}</style>` +
    `<script>${RV_HEAD_SCRIPT}</script>${googleTag}</head><body data-lp-design="${design}">` +
    header + ORDER[design](ctx).join("") + footer + bar + scripts + `</body></html>`;
}
