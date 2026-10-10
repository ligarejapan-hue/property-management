/**
 * 公開LP(設計 2026-09-08 §2.4)。React を使わない純関数。unsubscribe-page.ts と同じ作り。
 *  - 全ての動的値は escapeHtml。図(renderFigureHtml)だけは自前生成の固定 HTML/SVG としてそのまま埋める。
 *  - 見た目は 2026-10 の見本(発注者承認)どおり。会社固有の固定情報(ロゴ・受付時間・提携先など)は lp-brand.ts。
 *  - 画像は元の縦横比のまま(height:auto・object-fit:cover や aspect-ratio で切り落とさない=発注者ルール 2026-10-06)。
 *  - CSS は inline・外部読み込みなし。スマホ(〜767px)=1列+画面下の固定バー、PC(768px〜)=中央1列 760px。
 *  - <script> は電話タップ送信の固定文字列(live のみ)・申込フォーム・チェック札(live のみ)。token は jsString(JSON.stringify を
 *    </script>-safe にしたもの)で埋める。
 */
import { escapeHtml } from "./templates/index";
import { renderFigureHtml } from "./lp-figures";
import { LP_BRAND, type LpBrandImage } from "./lp-brand";
import { formatPhoneJp } from "../phone-format-jp";
import type { LpRenderInput, LpImage, LpFormInput } from "./lp-render-input";
import { PUBLIC_PAGE_HEADERS } from "./unsubscribe-page";
import { INQUIRY_LIMITS, HONEYPOT_FIELD, INQUIRY_ERROR_MESSAGES } from "./inquiry-input";
export { PUBLIC_PAGE_HEADERS } from "./unsubscribe-page";

export const LP_CTA_LABEL = "無料査定を申し込む";
const CONTACT_ID = "contact";
export const INQUIRY_SECTION_ID = "inquiry";

/** 公開LP用の応答ヘッダ。外部読み込みなしを regex ではなくブラウザに強制させる(CSP)。
 *  - `connect-src 'self'` = 電話タップの送信先が自分自身のときだけ通る(これが無いと sendBeacon/fetch ごと遮断される)。
 *  - `form-action 'self'` / `base-uri 'none'` = 万一 HTML に細工が入っても外部へ送出・相対URLの付け替えをさせない。
 *  preview route(社内プレビュー・iframe埋め込み)は呼び出し側で frame-ancestors 'self' に上書きする。 */
export const LP_PAGE_HEADERS: Readonly<Record<string, string>> = {
  ...PUBLIC_PAGE_HEADERS,
  "Content-Security-Policy":
    "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

/** JSON.stringify の出力を <script> タグ内にそのまま埋め込んでも安全な文字列にする。
 *  "</script>" のような文字列が値に含まれていても要素を閉じない(U+003C/E/&をエスケープ)。 */
function jsString(s: string): string {
  return JSON.stringify(s).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

// 2026-10 の見本(発注者承認)の色と書体。外部の書体は CSP(default-src 'none')で読めないため、端末の明朝体を使う。
const SERIF = "'Hiragino Mincho ProN','Yu Mincho','YuMincho','Noto Serif JP','BIZ UDPMincho',serif";
const CSS = [
  ":root{color-scheme:light}",
  "*{box-sizing:border-box}",
  "body{margin:0;background:#f6f1e7;color:#2b2a26;font-family:-apple-system,BlinkMacSystemFont,'Hiragino Kaku Gothic ProN','Yu Gothic UI','Noto Sans JP',sans-serif;font-size:16px;line-height:1.9;-webkit-text-size-adjust:100%}",
  "main{margin:0 auto;padding:0 0 96px}",
  `h1,h2,h3,.dl-when,.flow li::before,.faq .q,.faq .a b,.flow-total{font-family:${SERIF}}`,
  "h1{font-size:25px;line-height:1.5;margin:0 0 12px;letter-spacing:.02em}",
  "h2{font-size:21px;line-height:1.55;margin:0 0 12px;letter-spacing:.02em}",
  "h2::before{content:\"\";display:block;width:28px;height:3px;background:#0e6b5c;border-radius:2px;margin-bottom:10px}",
  "h3{font-size:18px;margin:4px 0 4px}",
  "p{margin:0 0 12px}",
  "a{color:#0a5246}",
  ".band{background:#f7ebdd;color:#a85f1b;font-weight:700;text-align:center;padding:8px 12px;font-size:14px}",
  // ── 上部(ロゴ・電話) ──
  ".top{background:#fffdf8;border-bottom:1px solid #ddd3bf}",
  ".top-in{max-width:760px;margin:0 auto;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px}",
  ".brand-link{display:block;line-height:0}",
  ".brand img{display:block;width:150px;max-width:40vw;height:auto}",
  ".brand small{display:block;margin-top:4px;font-size:11px;color:#5d594f;line-height:1.4}",
  ".top-tel{text-align:right;font-size:12px;color:#5d594f;line-height:1.4}",
  ".top-tel a{display:block;font-size:19px;font-weight:700;color:#0e6b5c;text-decoration:none;letter-spacing:.04em;font-variant-numeric:tabular-nums}",
  // ── ヒーロー(画像は元の縦横比のまま=height:auto・切り落としなし。発注者ルール 2026-10-06) ──
  ".hero{display:block;width:100%;height:auto;background:#ece4d3}",
  ".wrap{padding:20px 16px}",
  ".eyebrow{display:inline-block;font-size:13px;font-weight:700;color:#0e6b5c;background:#e3efe9;border-radius:999px;padding:2px 12px;margin:0 0 10px}",
  ".lead{color:#5d594f;font-size:16px}",
  ".promises{list-style:none;margin:14px 0 18px;padding:0;display:flex;flex-wrap:wrap;gap:8px}",
  ".promises li{background:#fffdf8;border:1px solid #ddd3bf;border-radius:999px;padding:4px 12px 4px 30px;font-size:14px;font-weight:700;position:relative}",
  ".promises li::before{content:\"\";position:absolute;left:11px;top:50%;width:10px;height:6px;margin-top:-5px;border-left:2.5px solid #0e6b5c;border-bottom:2.5px solid #0e6b5c;transform:rotate(-45deg)}",
  ".cta-row{display:grid;gap:10px;margin:8px 0}",
  ".cta{display:block;background:#0e6b5c;color:#fff;text-align:center;text-decoration:none;border-radius:10px;padding:14px;font-size:17px;font-weight:700;min-height:44px}",
  ".cta.secondary{background:#fffdf8;color:#0a5246;border:2px solid #0e6b5c}",
  // ── 本文の節 ──
  "section{margin:36px 0}",
  ".media{margin:10px 0 14px}",
  ".media img,img.fig{display:block;width:100%;height:auto;border-radius:12px;background:#ece4d3}",
  ".figure{margin:12px 0}",
  ".fig-svg svg{display:block;width:100%;height:auto;border-radius:12px;border:1px solid #ddd3bf;background:#fff}",
  ".dots{margin:0 0 12px;padding-left:1.3em}",
  ".dots li{margin:2px 0}",
  ".small-note{font-size:13px;color:#5d594f;line-height:1.7;margin-top:10px}",
  // チェック札(□ の行)。押すと緑に。選んだ内容はスクリプトが申込欄へ入れる。
  ".checks{list-style:none;margin:0 0 12px;padding:0;display:grid;gap:8px}",
  ".check label{display:grid;grid-template-columns:28px 1fr;gap:12px;align-items:start;background:#fffdf8;border:1.5px solid #ddd3bf;border-radius:12px;padding:12px 14px;cursor:pointer;line-height:1.65;min-height:44px;position:relative}",
  ".check input{position:absolute;opacity:0;width:1px;height:1px}",
  ".check .box{width:28px;height:28px;border:2px solid #ddd3bf;border-radius:6px;background:#f6f1e7;display:grid;place-items:center}",
  ".check .box::after{content:\"\";width:12px;height:7px;border-left:3px solid #fffdf8;border-bottom:3px solid #fffdf8;transform:rotate(-45deg) translate(1px,-1px);opacity:0}",
  ".check input:checked~.box{background:#0e6b5c;border-color:#0e6b5c}",
  ".check input:checked~.box::after{opacity:1}",
  ".check input:focus-visible~.box{outline:3px solid #f6d96b;outline-offset:2px}",
  ".check label:has(input:checked){border-color:#0e6b5c;background:#e3efe9}",
  ".check-result{background:#e3efe9;border-radius:12px;padding:14px;margin:0 0 12px}",
  ".check-msg{font-weight:700;margin:0 0 10px}",
  // 案内役
  ".guide{display:grid;grid-template-columns:96px 1fr;gap:14px;align-items:start;background:#fffdf8;border:1px solid #ddd3bf;border-radius:14px;padding:16px}",
  ".guide-fig{margin:0;display:grid;gap:4px;justify-items:center}",
  ".guide-img{display:block;width:96px;height:auto;border-radius:12px;border:3px solid #e3efe9}",
  ".guide-fig figcaption{font-size:10px;color:#5d594f;text-align:center;line-height:1.3}",
  ".guide-name{font-weight:700;color:#0e6b5c;font-size:14px;margin:0 0 4px}",
  ".guide h2{font-size:18px}",
  ".guide h2::before{display:none}",
  // 期限の年表
  ".deadline{background:#fffdf8;border:1px solid #ddd3bf;border-radius:14px;padding:18px 14px 8px}",
  ".dl-list{list-style:none;margin:0;padding:0}",
  ".dl-item{display:grid;grid-template-columns:96px 1fr;gap:12px;position:relative;padding-bottom:16px}",
  ".dl-item::before{content:\"\";position:absolute;left:48px;top:32px;bottom:0;width:2px;background:#ddd3bf}",
  ".dl-item:last-child::before{display:none}",
  ".dl-when{align-self:start;background:#ece4d3;border-radius:8px;text-align:center;padding:6px 4px;font-weight:700;font-size:14px;line-height:1.35;position:relative;z-index:1}",
  ".dl-item.key .dl-when{background:#0e6b5c;color:#fffdf8}",
  ".dl-what strong{display:block;font-size:16px}",
  ".dl-item.key .dl-what strong{color:#0e6b5c}",
  ".dl-what span{display:block;font-size:14px;color:#5d594f;line-height:1.6}",
  ".dl-what span+span{margin-top:4px;font-size:13px}",
  // 流れ
  ".flow{list-style:none;margin:0;padding:0;counter-reset:step;display:grid;gap:10px}",
  ".flow li{counter-increment:step;display:grid;grid-template-columns:40px 1fr;gap:12px;align-items:start;background:#fffdf8;border:1px solid #ddd3bf;border-radius:12px;padding:12px 14px}",
  ".flow li::before{content:counter(step);width:40px;height:40px;border-radius:50%;background:#e3efe9;color:#0e6b5c;font-weight:700;font-size:18px;display:grid;place-items:center}",
  ".flow strong{display:block}",
  ".flow span{display:block;font-size:14px;color:#5d594f;line-height:1.65}",
  ".flow-total{margin:12px 0 0;font-weight:700;color:#0e6b5c;font-size:17px}",
  // 売る・貸す・しばらく持つ
  ".options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}",
  // 3枚版(空き家など・リースバックなし)はスマホでも PC でも横に3つ(PC の4列より強い指定)
  ".options.three{grid-template-columns:repeat(3,minmax(0,1fr))}",
  ".opt-card{background:#fffdf8;border:1px solid #ddd3bf;border-radius:12px;padding:8px;text-align:center}",
  ".opt-card h3{font-size:16px}",
  ".opt-img{display:block;width:100%;max-width:200px;height:auto;margin:0 auto 6px;border-radius:10px}",
  ".opt-card p{font-size:12px;color:#5d594f;line-height:1.6;margin:0;text-align:left}",
  // 窓口はひとつ
  ".network{background:#fffdf8;border:1px solid #ddd3bf;border-radius:14px;padding:14px 4px;display:grid;gap:8px;justify-items:center;text-align:center}",
  ".net-svg{display:block;width:100%;max-width:420px;height:auto}",
  // よくある質問
  ".faq details{background:#fffdf8;border:1px solid #ddd3bf;border-radius:12px;margin:8px 0}",
  ".faq summary{cursor:pointer;list-style:none;display:grid;grid-template-columns:24px 1fr;gap:10px;align-items:start;padding:14px;font-weight:700;line-height:1.6;min-height:44px}",
  ".faq summary::-webkit-details-marker{display:none}",
  ".faq .q{color:#0e6b5c;font-size:19px;line-height:1.3}",
  ".faq .a{display:grid;grid-template-columns:24px 1fr;gap:10px;padding:0 14px 14px}",
  ".faq .a b{font-size:19px;line-height:1.4}",
  ".faq .a p{margin:0}",
  // ご相談の例(押すと広がる札)。続く札どうしは詰めて並べる。
  ".cases{display:grid;gap:12px;margin:0 0 36px}",
  "section.case{margin:0}",
  ".cases-head{margin:36px 0 4px}",
  ".case details{background:#fffdf8;border:1px solid #ddd3bf;border-radius:14px}",
  ".case summary{cursor:pointer;list-style:none;display:grid;gap:4px;padding:16px;min-height:44px}",
  ".case summary::-webkit-details-marker{display:none}",
  ".case-tag{justify-self:start;font-size:12px;font-weight:700;color:#0e6b5c;background:#e3efe9;border-radius:999px;padding:1px 10px}",
  `.case summary strong{font-family:${SERIF};font-size:18px;line-height:1.55}`,
  ".case-more{justify-self:start;font-size:14px;font-weight:700;color:#0a5246}",
  ".case-more::after{content:\" ▾\"}",
  ".case details[open] .case-more{display:none}",
  ".case-body{padding:0 16px 8px;border-top:1px dashed #ddd3bf;padding-top:12px;color:#3d3a33}",
  // 実例の札を横一列に並べてスワイプで送る形(発注者決定 2026-10-10・案B)。CASES_SCRIPT が .swipe を付けたときだけ効く
  // (JS なし・動きを減らす設定では上の2列の札のまま)。縦のスクロールと指2本の拡大は普通にできる(pan-y pinch-zoom=@codex #501 R2)。
  ".cases.swipe{display:block;overflow:hidden;touch-action:pan-y pinch-zoom;padding:4px 0 0}",
  ".cases.swipe .case-track{position:relative;display:flex;gap:14px;align-items:flex-start;will-change:transform;cursor:grab}",
  ".cases.swipe .case-track>.case{flex:0 0 min(82%,340px);transition:none}",
  ".cases.swipe .case-track.snap,.cases.swipe .case-track.snap>.case{transition:transform .45s cubic-bezier(.2,.7,.2,1),opacity .45s ease}",
  ".cases.swipe .case-track.dragging{cursor:grabbing;user-select:none;-webkit-user-select:none}",
  ".cases.swipe .case-nav{display:flex;align-items:center;justify-content:center;gap:14px;margin-top:14px}",
  ".cases.swipe .case-nav .arrow{flex:none;font:inherit;font-size:22px;line-height:1;width:44px;height:44px;border-radius:50%;border:1px solid #ddd3bf;background:#fffdf8;color:#0a5246;cursor:pointer}",
  ".cases.swipe .case-nav .arrow:disabled{opacity:.35;cursor:default}",
  // 札が多いとき(本文の見出しは最大30)も狭い画面からはみ出さないよう、点は折り返す(@codex #501 R1)
  ".cases.swipe .case-dots{display:flex;flex-wrap:wrap;justify-content:center;gap:8px 10px;min-width:0}",
  ".cases.swipe .case-dots button{width:12px;height:12px;padding:0;border:0;border-radius:50%;background:#ddd3bf;cursor:pointer}",
  ".cases.swipe .case-dots button.on{background:#0e6b5c;transform:scale(1.25)}",
  ".cases.swipe .case-nav button:focus-visible{outline:3px solid #0e6b5c;outline-offset:2px}",
  ".cases.swipe .case-hint{margin:6px 0 0;text-align:center;font-size:13px;color:#6b665b}",
  // 会社案内
  ".company{background:#fffdf8;border:1px solid #ddd3bf;border-radius:12px;padding:16px}",
  ".company .co-logo{display:block;width:140px;height:auto;margin-bottom:8px}",
  ".company .name{font-weight:700;font-size:17px}",
  ".company .contact{color:#5d594f;white-space:pre-wrap;word-break:break-all}",
  ".company .hours,.company .co-hp{color:#5d594f;margin:4px 0 0}",
  ".tel{display:block;margin-top:12px}",
  ".inquiry{background:#fffdf8;border:1px solid #ddd3bf;border-radius:12px;padding:16px}",
  ".inquiry fieldset{border:0;margin:0;padding:0;min-width:0}",
  ".inquiry label{display:block;margin:0 0 14px;font-weight:700}",
  ".inquiry .req,.inquiry .opt{display:inline-block;margin-left:8px;font-size:12px;font-weight:700;border-radius:4px;padding:0 6px;vertical-align:2px}",
  ".inquiry .req{background:#a85f1b;color:#fff}",
  ".inquiry .opt{background:#e6ebe9;color:#4a5b5e}",
  ".inquiry input,.inquiry textarea{display:block;width:100%;margin-top:6px;font:inherit;font-size:16px;font-weight:400;padding:10px 12px;border:1px solid #b9c6c2;border-radius:8px;background:#fff;color:#1f2a2d;min-height:44px}",
  ".inquiry textarea{min-height:120px;resize:vertical}",
  ".inquiry .pref{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:6px;font-weight:400}",
  ".inquiry .pref label{display:flex;align-items:center;gap:6px;margin:0;font-weight:400;min-height:44px}",
  ".inquiry .pref input,.inquiry .consent input{width:auto;min-height:0;margin:0}",
  ".inquiry .privacy{font-size:14px;color:#4a5b5e;background:#f6f7f6;border-radius:8px;padding:10px 12px;margin:4px 0 12px;white-space:normal}",
  ".inquiry .consent{display:flex;align-items:center;gap:8px;font-weight:700;min-height:44px}",
  ".inquiry button{margin-top:12px;width:100%;border:0;cursor:pointer;font:inherit;font-size:17px;font-weight:700}",
  ".inquiry fieldset:disabled button{background:#9fb3ae;cursor:not-allowed}",
  ".inquiry .fld-err{color:#b42318;font-weight:700;font-size:14px;margin:-8px 0 14px}",
  ".inquiry input.invalid,.inquiry textarea.invalid{border-color:#b42318;box-shadow:0 0 0 1px #b42318}",
  ".inquiry .consent input.invalid,.inquiry .pref input.invalid{outline:2px solid #b42318;outline-offset:2px}",
  ".inquiry .inq-note{color:#a85f1b;background:#f7ebdd;border-radius:8px;padding:10px 12px;margin:0 0 14px;font-weight:700;font-size:14px}",
  ".inq-msg{color:#a8481a;background:#fbeadf;border-radius:8px;padding:10px 12px;margin:8px 0;font-weight:700}",
  ".inq-msg ul{margin:0;padding-left:1.2em}",
  ".inq-done{color:#1f2a2d;background:#e8f1ee;border-radius:8px;padding:14px 12px;margin:0;font-weight:700}",
  ".hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}",
  ".unsub{margin-top:28px;font-size:13px;color:#6b7a7d;text-align:center}",
  ".unsub a{color:#6b7a7d}",
  ".bar{display:none}",
  "@media (max-width: 767px){",
  "  .bar{display:grid;grid-template-columns:1fr 1fr;gap:8px;position:fixed;bottom:0;left:0;right:0;z-index:50;padding:10px 12px calc(10px + env(safe-area-inset-bottom));background:rgba(255,255,255,.96);border-top:1px solid #d6dedb;backdrop-filter:saturate(1.2) blur(6px)}",
  "  .bar.single{grid-template-columns:1fr}",
  "  .bar .cta{padding:12px;font-size:16px}",
  "}",
  "@media (min-width: 768px){",
  "  main{max-width:760px;padding:24px 0 64px}",
  "  .hero{border-radius:14px}",
  "  .wrap{padding:24px 8px}",
  "  h1{font-size:32px}",
  "  h2{font-size:24px}",
  "  .cta{max-width:420px;margin:0 auto}",
  "  .cta-row{grid-template-columns:1fr 1fr}",
  "  .cta-row .cta{max-width:none;margin:0}",
  "  .split{display:grid;grid-template-columns:1fr 1fr;gap:24px;align-items:center}",
  "  .split .media{margin:0}",
  "  .guide{grid-template-columns:132px 1fr;padding:20px}",
  "  .guide-img{width:132px;height:auto}",
  "  .options{grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}",
  "  .opt-card{padding:14px}",
  "  .opt-card h3{font-size:18px}",
  "  .opt-card p{font-size:14px;line-height:1.7}",
  "  .cases{grid-template-columns:1fr 1fr;align-items:start}",
  "}",
  "@media (prefers-reduced-motion: reduce){*{scroll-behavior:auto!important;transition:none!important}}",
  "html{scroll-behavior:smooth}",
  // ── 動き(発注者承認 2026-10-08・見本 https://claude.ai/artifact/YENL8ErHQuMSHP2cjhSXwD)──
  // 「動きを減らす」設定でない端末だけ。隠すのは MOTION_SCRIPT が html に .anim を付けたときだけ
  // (JS なし・IntersectionObserver なしでは最初から全部見える)。画像は切り取らない・拡大しない。
  "@media (prefers-reduced-motion: no-preference){",
  // 1. 節がふわっと浮かび上がる
  ".anim main section{opacity:0;transform:translateY(18px);transition:opacity .7s ease,transform .7s cubic-bezier(.2,.7,.2,1)}",
  ".anim .cases-head{opacity:0;transform:translateY(18px);transition:opacity .7s ease,transform .7s cubic-bezier(.2,.7,.2,1)}",
  ".anim main section.in,.anim .cases-head.in{opacity:1;transform:none}",
  // 2. ヒーロー: 絵がやわらかく明るくなり、言葉が順に出る。申込ボタンにときどき光
  ".anim .hero{opacity:0;filter:saturate(.6) brightness(1.08);transition:opacity 1.2s ease,filter 1.6s ease}",
  ".anim .hero.in{opacity:1;filter:none}",
  ".anim .wrap>.eyebrow,.anim .wrap>h1,.anim .wrap>.lead,.anim .promises li,.anim .wrap>.cta-row{opacity:0;transform:translateY(12px);transition:opacity .7s ease,transform .7s ease}",
  ".anim .hero-go>.eyebrow{transition-delay:.2s}.anim .hero-go>h1{transition-delay:.4s}.anim .hero-go>.lead{transition-delay:.6s}",
  ".anim .hero-go .promises li:nth-child(1){transition-delay:.8s}.anim .hero-go .promises li:nth-child(2){transition-delay:.95s}.anim .hero-go .promises li:nth-child(3){transition-delay:1.1s}",
  ".anim .hero-go>.cta-row{transition-delay:1.3s}",
  ".anim .hero-go>.eyebrow,.anim .hero-go>h1,.anim .hero-go>.lead,.anim .hero-go .promises li,.anim .hero-go>.cta-row{opacity:1;transform:none}",
  ".cta:not(.secondary){position:relative;overflow:hidden}",
  ".cta:not(.secondary)::after{content:\"\";position:absolute;top:0;bottom:0;width:40%;left:-60%;background:linear-gradient(100deg,transparent,rgba(255,255,255,.35),transparent);transform:skewX(-20deg);animation:lp-shine 5s ease-in-out 2.5s infinite;pointer-events:none}",
  "@keyframes lp-shine{0%,70%{left:-60%}85%,100%{left:130%}}",
  ".inquiry fieldset:disabled .cta::after{display:none}",
  // 3. 期限の年表: 縦線が伸び、札が順に現れ、「売却期限」がそっと脈打つ
  ".anim .dl-item{opacity:0;transform:translateX(-12px);transition:opacity .5s ease,transform .5s ease}",
  ".anim .dl-item::before{transform:scaleY(0);transform-origin:top;transition:transform .6s ease}",
  ".anim .deadline.in .dl-item{opacity:1;transform:none}",
  ".anim .deadline.in .dl-item::before{transform:scaleY(1)}",
  ".anim .deadline.in .dl-item:nth-child(1),.anim .deadline.in .dl-item:nth-child(1)::before{transition-delay:.1s}",
  ".anim .deadline.in .dl-item:nth-child(2),.anim .deadline.in .dl-item:nth-child(2)::before{transition-delay:.6s}",
  ".anim .deadline.in .dl-item:nth-child(3),.anim .deadline.in .dl-item:nth-child(3)::before{transition-delay:1.1s}",
  ".anim .deadline.in .dl-item:nth-child(4){transition-delay:1.6s}",
  ".anim .deadline.in .dl-item.key .dl-when{animation:lp-pulse 2.2s ease-out 2.3s 2}",
  "@keyframes lp-pulse{0%{box-shadow:0 0 0 0 rgba(14,107,92,.45)}100%{box-shadow:0 0 0 14px rgba(14,107,92,0)}}",
  // 4. 流れ: 番号が1つずつ灯る
  ".anim .flow li{opacity:0;transform:translateY(10px);transition:opacity .5s ease,transform .5s ease}",
  ".anim .flow li::before{transition:background .4s ease,color .4s ease}",
  ".anim .flow-box.in .flow li{opacity:1;transform:none}",
  ".anim .flow-box.in .flow li::before{background:#0e6b5c;color:#fffdf8}",
  ".anim .flow-box.in .flow li:nth-child(2),.anim .flow-box.in .flow li:nth-child(2)::before{transition-delay:.35s}",
  ".anim .flow-box.in .flow li:nth-child(3),.anim .flow-box.in .flow li:nth-child(3)::before{transition-delay:.7s}",
  ".anim .flow-box.in .flow li:nth-child(4),.anim .flow-box.in .flow li:nth-child(4)::before{transition-delay:1.05s}",
  ".anim .flow-box.in .flow li:nth-child(5),.anim .flow-box.in .flow li:nth-child(5)::before{transition-delay:1.4s}",
  // 5. 売る・貸す・持つ: 札が順に浮かび、絵がゆっくり揺れる
  ".anim .opt-card{opacity:0;transform:translateY(16px);transition:opacity .6s ease,transform .6s cubic-bezier(.2,.7,.2,1),box-shadow .3s ease}",
  ".anim .options.in .opt-card{opacity:1;transform:none}",
  ".anim .options.in .opt-card:nth-child(2){transition-delay:.2s}.anim .options.in .opt-card:nth-child(3){transition-delay:.4s}.anim .options.in .opt-card:nth-child(4){transition-delay:.6s}",
  ".options.in .opt-img{animation:lp-float 5s ease-in-out 1.2s infinite}",
  ".options.in .opt-card:nth-child(2) .opt-img{animation-delay:2s}.options.in .opt-card:nth-child(3) .opt-img{animation-delay:2.8s}.options.in .opt-card:nth-child(4) .opt-img{animation-delay:3.6s}",
  "@keyframes lp-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}",
  ".opt-card:hover{box-shadow:0 8px 24px rgba(43,42,38,.12)}",
  // 6. 窓口はひとつ: 真ん中から線が伸び(線は pathLength=1)、札が順に現れる。真ん中から波紋
  ".anim .net-svg line{stroke-dasharray:1;stroke-dashoffset:1;transition:stroke-dashoffset .7s ease}",
  ".anim .net-svg .net-pill{opacity:0;transition:opacity .4s ease}",
  ".anim .network.in .net-svg line{stroke-dashoffset:0}",
  ".anim .network.in .net-svg .net-pill{opacity:1}",
  ".net-ripple{transform-box:fill-box;transform-origin:center}",
  ".network.in .net-ripple{animation:lp-ripple 2.8s ease-out 1.2s infinite}",
  "@keyframes lp-ripple{0%{transform:scale(1);opacity:.5}100%{transform:scale(1.9);opacity:0}}",
  // 7. 案内役: ときどき小さく会釈する
  ".guide-img{transform-origin:50% 90%;animation:lp-nod 6s ease-in-out 1s infinite}",
  "@keyframes lp-nod{0%,80%,100%{transform:rotate(0)}86%{transform:rotate(-2.5deg)}92%{transform:rotate(1.5deg)}}",
  // 8. チェック札: チェックがはねる / 9. 実例の札: 開くと中身がすっと出る
  ".check input:checked~.box{animation:lp-pop .3s ease}",
  "@keyframes lp-pop{0%{transform:scale(.8)}60%{transform:scale(1.15)}100%{transform:scale(1)}}",
  ".case details[open] .case-body{animation:lp-drop .4s ease}",
  "@keyframes lp-drop{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}",
  "}",
].join("\n");

/**
 * 動きのスクリプト(固定文字列・live/社内プレビューの両方)。「動きを減らす」設定や IntersectionObserver が
 * 無い端末では何もしない(=.anim を付けない=最初から全部見える)。画面に入った部品に .in を付けるだけ。
 */
const MOTION_SCRIPT = [
  "(function(){",
  'if(!window.IntersectionObserver||!window.matchMedia||window.matchMedia("(prefers-reduced-motion: reduce)").matches)return;',
  'var root=document.documentElement;try{',
  'root.classList.add("anim");',
  'var ts=document.querySelectorAll("main section,.cases-head,.deadline,.flow-box,.options,.network");',
  'var io=new IntersectionObserver(function(es){for(var i=0;i<es.length;i++){if(es[i].isIntersecting){es[i].target.classList.add("in");io.unobserve(es[i].target)}}},{threshold:0,rootMargin:"0px 0px -10% 0px"});',
  "for(var t=0;t<ts.length;t++){io.observe(ts[t])}",
  'var hero=document.querySelector(".hero"),wrap=document.querySelector("main>.wrap");',
  'requestAnimationFrame(function(){requestAnimationFrame(function(){if(hero){hero.classList.add("in")}if(wrap){wrap.classList.add("hero-go")}})});',
  // 安全網: 見張りがうまく動かない閲覧アプリでも、6秒後には全部出す。途中で例外が出たら動きをやめて全部見せる。
  'setTimeout(function(){var h=document.querySelectorAll(".anim main section,.anim .cases-head,.deadline,.flow-box,.options,.network");for(var i=0;i<h.length;i++){h[i].classList.add("in")}},6000);',
  '}catch(_){root.classList.remove("anim")}',
  "})();",
].join("");

/**
 * 実例の札を横一列に並べ、指のスワイプ(PC はマウスで引く・矢印・点)で1枚ずつ正面に送る(固定文字列・live/プレビュー両方)。
 * 発注者決定 2026-10-10(見本 https://claude.ai/artifact/9FAbNjEdPDrwkGhBKiq2my の案B)。
 * サーバーの HTML は押すと広がる札のまま。「動きを減らす」設定・札が1枚・JS なしでは組み替えない。
 * 組み替えの途中で失敗したら札を元の並びに戻す。引いたあとの指の離しで札が開かないようにし、横の札を押すとその札を正面へ。
 */
const CASES_SCRIPT = [
  "(function(){",
  'if(!window.matchMedia||window.matchMedia("(prefers-reduced-motion: reduce)").matches)return;',
  'var boxes=document.querySelectorAll(".cases");for(var b=0;b<boxes.length;b++){setup(boxes[b])}',
  'function mk(cls,txt,label){var e=document.createElement("button");e.type="button";if(cls){e.className=cls}e.textContent=txt;e.setAttribute("aria-label",label);return e}',
  "function setup(box){",
  'var cards=[];for(var c=box.firstElementChild;c;c=c.nextElementSibling){if(c.classList.contains("case")){cards.push(c)}}',
  "if(cards.length<2)return;",
  'var N=cards.length,track=document.createElement("div"),nav=document.createElement("div"),hint=document.createElement("p"),dw=document.createElement("div"),dots=[],prev,next;',
  "try{",
  'track.className="case-track";nav.className="case-nav";hint.className="case-hint";dw.className="case-dots";hint.textContent="左右にスワイプしてご覧ください";',
  // 横に隠れた札は「浮かび上がる動き」の見張りに入らないので、組み替えた札にはすぐ .in を付ける
  'for(var i=0;i<N;i++){track.appendChild(cards[i]);cards[i].classList.add("in")}',
  'prev=mk("arrow","‹","前の実例");next=mk("arrow","›","次の実例");',
  'for(var k=0;k<N;k++){dots.push(dw.appendChild(mk("",""," "+(k+1)+"件目の実例")))}',
  "nav.appendChild(prev);nav.appendChild(dw);nav.appendChild(next);",
  'box.appendChild(track);box.appendChild(nav);box.appendChild(hint);box.classList.add("swipe");',
  '}catch(_){for(var r=0;r<N;r++){box.appendChild(cards[r])}if(track.parentNode){track.parentNode.removeChild(track)}if(nav.parentNode){nav.parentNode.removeChild(nav)}if(hint.parentNode){hint.parentNode.removeChild(hint)}box.classList.remove("swipe");return}',
  "var pos=0,startX=0,startPos=0,pid=null,dragging=false,moved=false,suppress=false,lastDown=0;",
  "function center(i){return cards[i].offsetLeft+cards[i].offsetWidth/2}",
  "function stepW(){return(center(1)-center(0))||1}",
  "function at(p){if(p<=0)return center(0)+p*stepW();if(p>=N-1)return center(N-1)+(p-N+1)*stepW();var f=Math.floor(p);return center(f)+(p-f)*(center(f+1)-center(f))}",
  "function front(){return Math.max(0,Math.min(N-1,Math.round(pos)))}",
  "function paint(){",
  'track.style.transform="translateX("+(box.clientWidth/2-at(pos))+"px)";',
  'for(var i=0;i<N;i++){var d=Math.abs(i-pos);cards[i].style.transform="scale("+Math.max(0.9,1-d*0.1)+")";cards[i].style.opacity=String(Math.max(0.5,1-d*0.5))}',
  'var f=front();for(var j=0;j<N;j++){dots[j].classList.toggle("on",j===f);dots[j].setAttribute("aria-current",j===f?"true":"false")}',
  "prev.disabled=f===0;next.disabled=f===N-1}",
  // 正面以外で開いている札は閉じる(隠れた長い札の高さが残って、正面の札の下に空白ができないように=@codex #501 R1)
  'function go(t){pos=Math.max(0,Math.min(N-1,t));var f=front();for(var i=0;i<N;i++){var dd=i!==f?cards[i].querySelector("details[open]"):null;if(dd){dd.open=false}}track.classList.add("snap");paint()}',
  'prev.addEventListener("click",function(){go(front()-1)});next.addEventListener("click",function(){go(front()+1)});',
  'for(var q=0;q<N;q++){dots[q].addEventListener("click",(function(n){return function(){go(n)}})(q))}',
  'box.addEventListener("keydown",function(e){if(e.key==="ArrowRight"){go(front()+1)}else if(e.key==="ArrowLeft"){go(front()-1)}});',
  // 指で引く。押せる部品と開いた本文の上からは引かない(文字を選べるように)
  // 押し始めで、前の「引いたあとのクリック抑止」を解く(指で引いたあとはクリックが来ないことがあるため)
  'track.addEventListener("pointerdown",function(e){suppress=false;lastDown=Date.now();if(e.button>0)return;if(e.target.closest&&e.target.closest("a,input,label,textarea,select,.case-body"))return;dragging=true;moved=false;startX=e.clientX;startPos=pos;pid=e.pointerId});',
  // マウスのボタンが札の外で離されていたら、引くのをやめる(8px 動く前は捕捉していないため pointerup が届かない)
  'track.addEventListener("pointermove",function(e){if(!dragging||e.pointerId!==pid)return;if(e.pointerType==="mouse"&&e.buttons===0){dragging=false;if(moved){finish();go(Math.round(pos))}return}var dx=e.clientX-startX;',
  'if(!moved&&Math.abs(dx)>8){moved=true;track.classList.remove("snap");track.classList.add("dragging");try{track.setPointerCapture(pid)}catch(_){}}',
  "if(!moved)return;pos=Math.max(-0.35,Math.min(N-0.65,startPos-dx/stepW()));paint()});",
  'function finish(){dragging=false;track.classList.remove("dragging");suppress=true;setTimeout(function(){suppress=false},400)}',
  // 指を離したら近い札へ。軽く払っただけでも1枚は進む
  'track.addEventListener("pointerup",function(e){if(!dragging||e.pointerId!==pid)return;if(!moved){dragging=false;return}finish();var dx=e.clientX-startX,t=Math.round(pos);if(t===Math.round(startPos)&&Math.abs(dx)>40){t+=dx<0?1:-1}go(t)});',
  'track.addEventListener("pointercancel",function(e){if(!dragging||e.pointerId!==pid)return;if(!moved){dragging=false;return}finish();go(Math.round(pos))});',
  'function onClick(e){if(suppress){e.preventDefault();e.stopPropagation();suppress=false;return}var c=e.target.closest?e.target.closest(".case"):null;var i=cards.indexOf(c);if(i>=0&&i!==front()&&e.target.closest("summary")){e.preventDefault();go(i)}}',
  'track.addEventListener("click",onClick,true);',
  // Tab で横の札へ移ったら正面へ送る(押して移ったときは onClick に任せる)。箱は overflow:hidden でも
  // フォーカスで横にずれることがあるので、ずれは戻す(位置は transform だけで決める)
  'box.addEventListener("focusin",function(e){if(Date.now()-lastDown<600)return;var c=e.target.closest?e.target.closest(".case"):null;var i=cards.indexOf(c);box.scrollLeft=0;if(i>=0&&i!==front()){go(i)}});',
  'box.addEventListener("scroll",function(){if(box.scrollLeft){box.scrollLeft=0}});',
  'window.addEventListener("resize",paint);window.addEventListener("load",paint);paint()',
  "}",
  "})();",
].join("");

function img(image: LpImage, cls: string, alt: string, priority = false): string {
  const loadAttrs = priority ? `loading="eager" fetchpriority="high"` : `loading="lazy"`;
  return `<img class="${cls}" src="/lp-assets/${escapeHtml(image.publicId)}" width="${image.width}" height="${image.height}" alt="${escapeHtml(alt)}" ${loadAttrs} decoding="async" />`;
}

const CHECK_DEFAULT_MSG = "ひとつでも当てはまれば、ご相談いただけます。";

function isLineList(p: string, mark: string): boolean {
  const lines = p.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  return lines.length > 0 && lines.every((l) => l.startsWith(mark));
}

/**
 * 段落を描く(2026-10 見本)。行がすべて「□」で始まる段落=タップで選べるチェック札、
 * すべて「・」=箇条書き、それ以外=段落。チェック札の下には「相談する」ボタン(ctaHtml)を添える。
 */
function paragraphs(ps: string[], ctaHtml = ""): string {
  return ps.map((p) => {
    const items = p.split("\n").map((l) => l.trim()).filter((l) => l.length > 0).map((l) => l.slice(1).trim()).filter((t) => t.length > 0);
    if (isLineList(p, "□")) {
      return `<ul class="checks">` +
        items.map((t) => `<li class="check"><label><input type="checkbox" data-check="1" value="${escapeHtml(t)}" /><span class="box" aria-hidden="true"></span><span>${escapeHtml(t)}</span></label></li>`).join("") +
        `</ul><div class="check-result"><p class="check-msg" data-check-msg="1" aria-live="polite">${CHECK_DEFAULT_MSG}</p>${ctaHtml}</div>`;
    }
    if (isLineList(p, "・")) return `<ul class="dots">${items.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>`;
    return `<p>${escapeHtml(p).replace(/\n/g, "<br />")}</p>`;
  }).join("");
}

/**
 * チェック札のスクリプト(固定文字列)。選んだ数を知らせ、選んだ項目を申込フォームの「ご要望・ご質問」へ入れる。
 * 人が書き足した欄は上書きしない(空か、前回この仕組みで入れた文のままのときだけ入れる)。表示は textContent だけ。
 */
const CHECKLIST_SCRIPT = [
  "(function(){",
  'var bs=document.querySelectorAll("input[data-check]");if(!bs.length)return;',
  'var msgs=document.querySelectorAll("[data-check-msg]");',
  'var ta=document.querySelector("form[data-inquiry] textarea[name=message]");',
  `var MAX=${INQUIRY_LIMITS.message};var last="";`,
  'function up(){var t=[];for(var i=0;i<bs.length;i++){if(bs[i].checked){t.push("・"+bs[i].value)}}',
  `var s=t.length?t.length+"つ当てはまりました。この内容のまま、ご相談いただけます。":${jsString(CHECK_DEFAULT_MSG)};for(var k=0;k<msgs.length;k++){msgs[k].textContent=s}`,
  'if(ta&&(ta.value===""||ta.value===last)){var v=t.join("\\n");if(v.length>MAX){v=v.slice(0,MAX)}ta.value=v;last=v}}',
  'for(var j=0;j<bs.length;j++){bs[j].addEventListener("change",up)}',
  "})();",
].join("");

function formatTel(digits: string): string {
  return formatPhoneJp(digits).value;
}

/**
 * 画面内の入力チェック(ES5 の関数式の文字列)。送信前にブラウザで走らせ、足りない欄を
 * [{f: 欄の name, m: 文言}] で**画面の上から順に**返す(最初の欄へスクロールするため)。
 * ⚠発注者の指定(2026-09-26)=「進めないときは入力欄のところに赤字で注意書きをして、そこまでスクロール」。
 *   スマホのブラウザ任せの吹き出しは見えないことがあり、同意のチェック忘れで無言のまま止まっていた。
 * 判定は inquiry-input.ts の parseInquiryForm と同じ規則(サーバー側の検証が正本・ここは先回りの案内)。
 * 文言も同じ INQUIRY_ERROR_MESSAGES を埋める(二重管理にしない)。
 */
export const INQUIRY_CLIENT_CHECK_SOURCE = [
  "function(v){var E=[];",
  `var M=${jsString(JSON.stringify(INQUIRY_ERROR_MESSAGES))};M=JSON.parse(M);`,
  // 全角→半角(NFKC)が無い古いブラウザでは形式のチェックをしない(全角の正しい番号を弾かない・@codex #446 R2)。
  // 空・同意なしだけ注意し、形式はサーバー(parseInquiryForm)に任せる。
  'var canN=typeof "".normalize==="function";',
  'function n(s){s=String(s==null?"":s);if(canN){try{s=s.normalize("NFKC")}catch(_){}}return s.replace(/[\\u0000-\\u001f\\u007f]/g,"").trim()}',
  'var nm=n(v.name);if(nm===""){E.push({f:"name",m:M.name_required})}else if(canN&&/[0-9@]/.test(nm)){E.push({f:"name",m:M.name_invalid})}',
  'var ph=n(v.phone).replace(/[ー−–—―]/g,"-").replace(/\\s+/g,"");',
  `if(ph===""){E.push({f:"phone",m:M.phone_required})}else if(canN&&(ph.length>${INQUIRY_LIMITS.phone}||!/^[0-9+\\-]+$/.test(ph)||ph.replace(/[^0-9]/g,"").length<10)){E.push({f:"phone",m:M.phone_invalid})}`,
  'var em=n(v.email);if(canN&&em!==""&&!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(em)){E.push({f:"email",m:M.email_invalid})}',
  'if(n(v.pref)==="email"&&em===""){E.push({f:"email",m:M.email_required_for_pref})}',
  'if(!v.consent){E.push({f:"consent",m:M.consent_required})}',
  "return E}",
].join("");

/** 申込フォームの送信スクリプト(フォームが有効なときだけ出す・固定文字列)。
 *  - fetch/URLSearchParams/FormData があれば画面を離れずに送る(accept: application/json)。
 *    サーバーの指摘(422 等)は送信ボタンの上の .inq-msg に出し、入力はそのまま残す。
 *  - 無いブラウザは preventDefault せず従来どおり通常送信(JS なしと同じ)+二重送信防止だけ。
 *  - 表示は textContent / createElement だけで組む(innerHTML は使わない)。
 *  - bfcache から戻ったとき(pageshow)は送信ボタンを押せる状態に戻す。 */
const INQUIRY_SUBMIT_SCRIPT = [
  "(function(){",
  'var f=document.querySelector("form[data-inquiry]");if(!f)return;',
  'var M={done:"お申し込みを受け付けました。内容を確認のうえ、担当者からご連絡いたします。",' +
    'preview:"まだお申し込みを受け付けていません。お急ぎの場合はお電話ください。",' +
    'throttled:"アクセスが集中しています。しばらく時間をおいてもう一度お試しください。",' +
    'fail:"お申し込みを完了できませんでした。少し時間をおいてもう一度お試しいただくか、お電話ください。"};',
  "var sending=false;",
  'function btn(){return f.querySelector("button[type=submit]")}',
  "function enable(){sending=false;var b=btn();if(b){b.disabled=false}}",
  'function box(){return f.querySelector(".inq-msg")}',
  "function show(lines,asList){var x=box();if(!x)return;while(x.firstChild){x.removeChild(x.firstChild)}" +
    'if(asList){var ul=document.createElement("ul");for(var i=0;i<lines.length;i++){var li=document.createElement("li");li.textContent=lines[i];ul.appendChild(li)}x.appendChild(ul)}' +
    "else{x.textContent=lines[0]}x.hidden=false;if(x.scrollIntoView){x.scrollIntoView({block:\"center\"})}}",
  // ── 画面内の入力チェック(ブラウザ任せの吹き出しは止める=JS なしのときだけ required が効く) ──
  `f.noValidate=true;var CK=${INQUIRY_CLIENT_CHECK_SOURCE};`,
  "function errEl(k){return f.querySelector('[data-err-for=\"'+k+'\"]')}",
  "function fieldOf(k){return f.querySelector('[name=\"'+k+'\"]')}",
  'function clearErrs(){var ps=f.querySelectorAll(".fld-err");for(var i=0;i<ps.length;i++){ps[i].hidden=true;ps[i].textContent=""}var bad=f.querySelectorAll(".invalid");for(var j=0;j<bad.length;j++){bad[j].classList.remove("invalid");bad[j].removeAttribute("aria-invalid")}}',
  "function vals(){var c=fieldOf(\"consent\");var p=f.querySelector('input[name=\"contactPref\"]:checked');" +
    'function val(k){var el=fieldOf(k);return el?el.value:""}' +
    'return{name:val("name"),phone:val("phone"),email:val("email"),pref:p?p.value:"",consent:!!(c&&c.checked)}}',
  "function flag(errs){for(var i=0;i<errs.length;i++){var p=errEl(errs[i].f);if(p){p.textContent=errs[i].m;p.hidden=false}" +
    'var el=fieldOf(errs[i].f);if(el){el.classList.add("invalid");el.setAttribute("aria-invalid","true")}}' +
    'var first=errEl(errs[0].f)||fieldOf(errs[0].f);if(first&&first.scrollIntoView){first.scrollIntoView({block:"center"})}' +
    "var fe=fieldOf(errs[0].f);if(fe&&fe.focus){try{fe.focus({preventScroll:true})}catch(_){fe.focus()}}}",
  // 直した欄の注意を消す。連絡方法を変えたときは、それに連動する「メールが空」の注意(メール欄)も消す(@codex #446 R4)。
  'var DEP={contactPref:"email"};' +
  'function clearField(k){var p=errEl(k);if(p){p.hidden=true;p.textContent=""}' +
    'var same=f.querySelectorAll(\'[name="\'+k+\'"]\');for(var i=0;i<same.length;i++){same[i].classList.remove("invalid");same[i].removeAttribute("aria-invalid")}}',
  'function onEdit(e){var t=e.target;if(!t||!t.name)return;clearField(t.name);if(DEP[t.name]){clearField(DEP[t.name])}}',
  'f.addEventListener("input",onEdit);f.addEventListener("change",onEdit);',
  'function done(){while(f.firstChild){f.removeChild(f.firstChild)}var p=document.createElement("p");p.className="inq-done";p.setAttribute("role","status");p.textContent=M.done;f.appendChild(p)}',
  "function handle(d){var k=d&&d.result;" +
    'if(k==="done"){done();return}' +
    'if(k==="invalid"){var ms=[];if(d.messages&&d.messages.length){for(var i=0;i<d.messages.length;i++){if(typeof d.messages[i]==="string"){ms.push(d.messages[i])}}}' +
    "if(ms.length){show(ms,true);enable();return}}" +
    'if(k==="preview"){show([M.preview]);enable();return}' +
    'if(k==="throttled"){show([M.throttled]);enable();return}' +
    "show([M.fail]);enable()}",
  'f.addEventListener("submit",function(e){',
  "if(sending){e.preventDefault();return}",
  // 足りない欄があれば送らず、その欄の下に赤字の注意+最初の欄までスクロール(発注者指定)。
  "clearErrs();var errs=CK(vals());if(errs.length){e.preventDefault();flag(errs);return}",
  "var body=null;",
  // 古いブラウザの new URLSearchParams(formData) は黙って "[object FormData]" になるため、forEach で文字列欄だけ詰める。
  'if(!window.fetch||!window.URLSearchParams||!window.FormData){body=null}else{try{var fd=new FormData(f);if(typeof fd.forEach==="function"){var q=new URLSearchParams();fd.forEach(function(v,k){if(typeof v==="string"){q.append(k,v)}});body=q.toString()}}catch(_){body=null}}',
  // 送れないときは preventDefault せず通常送信(JS なしと同じ)。二重送信防止だけ残す。
  'if(body===null){var b0=btn();if(b0){setTimeout(function(){b0.disabled=true},0)}return}',
  "e.preventDefault();sending=true;var b=btn();if(b){b.disabled=true}var x=box();if(x){x.hidden=true}",
  'fetch(f.action,{method:"POST",headers:{"accept":"application/json","content-type":"application/x-www-form-urlencoded;charset=UTF-8"},body:body,credentials:"same-origin"})',
  ".then(function(r){return r.json()}).then(handle,function(){show([M.fail]);enable()})",
  "});",
  'window.addEventListener("pageshow",function(){var b=btn();if(b){b.disabled=false}sending=false});',
  "})();",
].join("");

/** 入力欄の直下に出す赤字の注意書きの置き場(画面内チェックが textContent で埋める・初期は隠す)。 */
function fieldError(name: string): string {
  return `<p class="fld-err" data-err-for="${name}" role="alert" hidden></p>`;
}

function formSection(form: LpFormInput): string {
  const privacy = escapeHtml(form.privacyText).replace(/\n/g, "<br />");
  const pref = (value: string, label: string) =>
    `<label><input type="radio" name="contactPref" value="${value}" />${label}</label>`;
  return `<section class="inquiry" id="${INQUIRY_SECTION_ID}"><h2>${escapeHtml(LP_CTA_LABEL)}</h2>` +
    `<form method="post" action="${escapeHtml(form.action)}" data-inquiry="1">` +
    // 送付前は欄がすべて入力できない。上部の帯だけでは気づかれない(2026-09-26 実機テスト)ので、フォームの中にも理由を書く。
    (form.disabled ? `<p class="inq-note">この宛先はまだ送付前のため、入力とお申し込みはできません(社内確認用の表示です。「送付済み」にすると入力できます)。</p>` : "") +
    `<fieldset${form.disabled ? " disabled" : ""}>` +
    `<label>お名前<span class="req">必須</span><input name="name" type="text" required maxlength="${INQUIRY_LIMITS.name}" autocomplete="name" /></label>${fieldError("name")}` +
    `<label>電話番号<span class="req">必須</span><input name="phone" type="tel" required maxlength="${INQUIRY_LIMITS.phone}" inputmode="tel" autocomplete="tel" placeholder="例: 09012345678(ハイフンなしでも可)" /></label>${fieldError("phone")}` +
    `<label>メールアドレス<span class="opt">任意</span><input name="email" type="email" maxlength="${INQUIRY_LIMITS.email}" autocomplete="email" /></label>${fieldError("email")}` +
    `<div><strong>ご希望の連絡方法</strong><span class="opt">任意</span><div class="pref">${pref("phone", "電話")}${pref("email", "メール")}${pref("either", "どちらでも")}</div></div>` +
    `<label>連絡のつきやすい時間帯<span class="opt">任意</span><input name="contactTime" type="text" maxlength="${INQUIRY_LIMITS.contactTime}" placeholder="例: 平日18時以降" /></label>` +
    `<label>ご要望・ご質問<span class="opt">任意</span><textarea name="message" maxlength="${INQUIRY_LIMITS.message}" rows="4"></textarea></label>` +
    `<div class="hp" aria-hidden="true"><label>この欄は空のままにしてください<input name="${HONEYPOT_FIELD}" type="text" tabindex="-1" autocomplete="off" /></label></div>` +
    `<div class="privacy">${privacy}</div>` +
    `<label class="consent"><input type="checkbox" name="consent" value="yes" required />個人情報の取り扱いに同意する</label>${fieldError("consent")}` +
    `<div class="inq-msg" role="alert" aria-live="assertive" hidden></div>` +
    `<button type="submit" class="cta">${escapeHtml(LP_CTA_LABEL)}</button>` +
    `</fieldset></form></section>`;
}

/** 会社固有の静的画像(public/lp-assets/brand/)。元の縦横比の実寸を width/height に持つ。 */
function brandImg(image: LpBrandImage, cls: string, eager = false): string {
  return `<img class="${cls}" src="${escapeHtml(image.src)}" width="${image.width}" height="${image.height}" alt="${escapeHtml(image.alt)}" ${eager ? 'loading="eager"' : 'loading="lazy"'} decoding="async" />`;
}

/** 見出しがこの言葉で始まる節は「ご相談の例(実例)」=押すと広がる札で描く(発注者要望 2026-10-07)。 */
const CASE_PREFIXES = ["ご相談の例", "実例"] as const;
/** 見出しが実例の札の対象なら、その言葉を返す。言葉の直後は「終わり・区切り記号・かっこ・数字」に限る
 *  (「実例集のご紹介」のような、ふつうの節を誤って札にしない)。 */
function casePrefixOf(heading: string): string | undefined {
  return CASE_PREFIXES.find((p) => heading.startsWith(p) && /^($|[\s:：・|｜()（）「」【】〈〉\-－–—0-9０-９①-⑳])/.test(heading.slice(p.length)));
}

/**
 * 実例の札。見出しの残り(「(世田谷区・戸建て・築35年)」など)を小さな札に、
 * 本文全体の1行目を題に、残りを開いたときの本文にする(題のあとに空行があっても同じ=@codex #488 R2 P2)。
 * 本文が1行しか無いときは見出しを題にして、その1行を中に入れる。
 */
function renderCaseSection(s: LpRenderInput["sections"][number], prefix: string, cta: string): string {
  const rest = s.heading.slice(prefix.length).replace(/^[\s:：・|｜（(]+|[\s）)]+$/g, "");
  const tag = rest ? `${prefix} ${rest}` : prefix; // 区切りはスペース(発注者指定 2026-10-07)
  const [first = "", ...others] = s.paragraphs;
  const firstLines = first.split("\n");
  const totalLines = s.paragraphs.reduce((n, p) => n + p.split("\n").length, 0);
  const hasTitleLine = totalLines > 1 && firstLines[0].trim().length > 0;
  const title = hasTitleLine ? firstLines[0].trim() : s.heading;
  const restOfFirst = firstLines.slice(1).join("\n");
  const bodyParas = hasTitleLine ? [...(restOfFirst.trim() ? [restOfFirst] : []), ...others] : s.paragraphs;
  // 写真も図も落とさない(@codex #488 R1 P2: 管理画面ではどの節にも図を付けられる)。写真は本文の前、図は本文の後。
  // 案内役は絵だけでなく、名乗り+本文と組んだ形のまま札の中に置く(@codex #488 R5 P2)。
  const isGuide = s.media?.kind === "figure" && s.media.figureKind === "consult_guide";
  const photo = s.media?.kind === "asset" ? `<div class="media">${img(s.media.image, "fig", s.heading)}</div>` : "";
  const figure = s.media?.kind === "figure" && !isGuide ? `<div class="figure">${renderFigureHtml(s.media.figureKind)}</div>` : "";
  const text = paragraphs(bodyParas, cta);
  const inner = isGuide
    ? `<div class="guide">${renderFigureHtml("consult_guide")}<div><p class="guide-name">${escapeHtml(LP_BRAND.guideName)}</p>${text}</div></div>`
    : `${photo}${text}${figure}`;
  return `<section class="case"><details><summary><span class="case-tag">${escapeHtml(tag)}</span><strong>${escapeHtml(title)}</strong>` +
    `<span class="case-more" aria-hidden="true">続きを読む</span></summary><div class="case-body">${inner}</div></details></section>`;
}

function renderSection(s: LpRenderInput["sections"][number], cta: string): string {
  const casePrefix = casePrefixOf(s.heading);
  if (casePrefix) return renderCaseSection(s, casePrefix, cta);
  const h2 = `<h2>${escapeHtml(s.heading)}</h2>`;
  const body = paragraphs(s.paragraphs, cta);
  if (s.media?.kind === "asset") {
    // 写真つきの節: PC は写真と文章の2列(スマホは縦に積む)。写真は元の比率のまま。
    return `<section><div class="split"><div class="media">${img(s.media.image, "fig", s.heading)}</div><div class="sec-body">${h2}${body}</div></div></section>`;
  }
  if (s.media?.kind === "figure" && s.media.figureKind === "consult_guide") {
    // 案内役: イメージイラストの横に、名乗り+この節の見出しと文章。
    return `<section><div class="guide">${renderFigureHtml("consult_guide")}<div><p class="guide-name">${escapeHtml(LP_BRAND.guideName)}</p>${h2}${body}</div></div></section>`;
  }
  const figure = s.media?.kind === "figure" ? `<div class="figure">${renderFigureHtml(s.media.figureKind)}</div>` : "";
  return `<section>${h2}${body}${figure}</section>`;
}

export function renderLpPage(input: LpRenderInput): string {
  const ctaTarget = input.form ? INQUIRY_SECTION_ID : CONTACT_ID;
  const cta = `<a class="cta" href="#${ctaTarget}">${escapeHtml(LP_CTA_LABEL)}</a>`;
  const telHref = input.company.phone ? `tel:${escapeHtml(input.company.phone)}` : null;
  const telBtn = telHref ? `<a class="cta secondary tel" href="${telHref}" data-phone-tap="1">電話で相談する</a>` : "";
  const header = `<header class="top"><div class="top-in"><div class="brand">` +
    `<a class="brand-link" href="${escapeHtml(LP_BRAND.homepageUrl)}" target="_blank" rel="noopener">${brandImg(LP_BRAND.logo, "logo", true)}</a>` +
    `<small>${escapeHtml(LP_BRAND.tagline)}</small></div>` +
    (telHref && input.company.phone
      ? `<div class="top-tel">お電話でのご相談(${escapeHtml(LP_BRAND.phoneHours)})<a href="${telHref}" data-phone-tap="1">${escapeHtml(formatTel(input.company.phone))}</a></div>`
      : "") +
    `</div></header>`;
  const heroCopy = `<p class="eyebrow">${escapeHtml(LP_BRAND.heroEyebrow)}</p><h1>${escapeHtml(input.headline)}</h1>` +
    (input.lead ? `<p class="lead">${escapeHtml(input.lead)}</p>` : "") +
    `<ul class="promises">${LP_BRAND.promises.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>` +
    `<div class="cta-row">${cta}${telHref ? `<a class="cta secondary" href="${telHref}" data-phone-tap="1">電話で相談する</a>` : ""}</div>`;
  // 実例の札が続く並びは1つの枠(.cases=PC では左右2列)にまとめ、先頭にまとめの見出しを1つ置く。
  const isCase = (h: string) => casePrefixOf(h) !== undefined;
  const sections = input.sections.map((s, i) => {
    const html = renderSection(s, cta);
    if (!isCase(s.heading)) return html;
    const first = !(i > 0 && isCase(input.sections[i - 1].heading));
    const last = !(i + 1 < input.sections.length && isCase(input.sections[i + 1].heading));
    return (first ? `<h2 class="cases-head">これまでのご相談から</h2><div class="cases">` : "") + html + (last ? `</div>` : "");
  }).join("");
  const introHtml = paragraphs(input.intro, cta);
  // チェック札を実際に描いたかで判定する(元の段落で判定すると、実例の題を切り分けた後にできた札を見落とす=@codex #488 R4 P2)。
  const hasChecks = /data-check="1"/.test(introHtml + sections);
  const faq = input.faq.length === 0 ? "" : `<section><h2>よくあるご質問</h2><div class="faq">${input.faq.map((f) =>
    `<details><summary><span class="q">Q</span><span>${escapeHtml(f.q)}</span></summary><div class="a"><b>A</b><p>${escapeHtml(f.a).replace(/\n/g, "<br />")}</p></div></details>`,
  ).join("")}</div></section>`;
  const company = `<section class="company" id="${CONTACT_ID}">` +
    brandImg(LP_BRAND.logo, "co-logo") +
    (input.company.name ? `<div class="name">${escapeHtml(input.company.name)}</div>` : "") +
    (input.company.contact ? `<div class="contact">${escapeHtml(input.company.contact)}</div>` : "") +
    (telHref ? `<p class="hours">受付時間 ${escapeHtml(LP_BRAND.phoneHours)}</p>` : "") +
    `<p class="co-hp">ホームページ <a href="${escapeHtml(LP_BRAND.homepageUrl)}" target="_blank" rel="noopener">${escapeHtml(LP_BRAND.homepageUrl.replace(/^https:\/\//, "").replace(/\/$/, ""))}</a></p>` +
    `<p style="margin-top:10px">${input.form ? "お電話でのご相談も承ります。" : "無料査定のお申し込み・ご相談は、お電話で承ります。"}</p>${telBtn}</section>`;
  const unsub = input.unsubscribeUrl ? `<p class="unsub">今後このようなお手紙が不要な方は <a href="${escapeHtml(input.unsubscribeUrl)}">こちら(配信停止)</a></p>` : "";
  const band = input.mode === "preview" ? `<div class="band">プレビュー ── この宛先はまだ送付前です。お申し込みは受け付けません</div>` : "";
  const bar = telHref
    ? `<div class="bar">${cta}<a class="cta secondary" href="${telHref}" data-phone-tap="1">電話</a></div>`
    : `<div class="bar single">${cta}</div>`;
  const script = input.mode === "live" && input.phoneTapToken && telHref
    ? (() => {
        const url = jsString(`/t/${input.phoneTapToken}/phone-tap`);
        return `<script>(function(){document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("[data-phone-tap]"):null;if(!a)return;try{if(navigator.sendBeacon){navigator.sendBeacon(${url})}else{fetch(${url},{method:"POST",keepalive:true}).catch(function(){})}}catch(_){}});})();</script>`;
      })()
    : "";
  const submitGuard = input.form && !input.form.disabled
    ? `<script>${INQUIRY_SUBMIT_SCRIPT}</script>`
    : "";
  // チェック札の数の表示・申込欄への写し(live のみ。preview は script を出さない=見た目だけ CSS で切り替わる)。
  const checklistScript = input.mode === "live" && hasChecks ? `<script>${CHECKLIST_SCRIPT}</script>` : "";
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><meta name="robots" content="noindex,nofollow" /><meta name="referrer" content="strict-origin" /><title>${escapeHtml(input.headline)}</title><style>${CSS}</style></head><body>${band}${header}<main>` +
    (input.hero ? img(input.hero, "hero", "", true) : "") +
    `<div class="wrap">${heroCopy}` +
    introHtml + sections + faq + (input.form ? formSection(input.form) : "") + company + unsub +
    `</div></main>${bar}${script}${submitGuard}${checklistScript}<script>${MOTION_SCRIPT}${sections.includes('<div class="cases">') ? CASES_SCRIPT : ""}</script></body></html>`;
}
