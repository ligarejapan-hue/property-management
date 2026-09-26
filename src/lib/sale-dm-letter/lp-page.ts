/**
 * 公開LP(設計 2026-09-08 §2.4)。React を使わない純関数。unsubscribe-page.ts と同じ作り。
 *  - 全ての動的値は escapeHtml。図(renderFigureSvg)だけは自前生成の SVG としてそのまま埋める。
 *  - CSS は inline・外部読み込みなし。スマホ(〜767px)=1列+画面下の固定バー、PC(768px〜)=中央1列 760px。
 *  - <script> は電話タップ送信の固定文字列1本(live のみ)。token は jsString(JSON.stringify を
 *    </script>-safe にしたもの)で埋める。
 */
import { escapeHtml } from "./templates/index";
import { renderFigureSvg } from "./lp-figures";
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

const CSS = [
  ":root{color-scheme:light}",
  "*{box-sizing:border-box}",
  "body{margin:0;background:#f6f7f6;color:#1f2a2d;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Hiragino Kaku Gothic ProN','Yu Gothic UI','Noto Sans JP',sans-serif;font-size:16px;line-height:1.9;-webkit-text-size-adjust:100%}",
  "main{margin:0 auto;padding:0 0 96px}",
  "h1{font-size:24px;line-height:1.4;margin:0}",
  "h2{font-size:19px;line-height:1.45;margin:0 0 8px;padding-left:10px;border-left:4px solid #0e6b5c}",
  "p{margin:0 0 12px}",
  ".band{background:#f7ebdd;color:#a85f1b;font-weight:700;text-align:center;padding:8px 12px;font-size:14px}",
  ".hero{display:block;width:100%;height:auto;aspect-ratio:16/9;object-fit:cover;background:#e6ebe9}",
  ".wrap{padding:20px}",
  ".lead{color:#4a5b5e;font-size:16px}",
  ".cta{display:block;background:#0e6b5c;color:#fff;text-align:center;text-decoration:none;border-radius:10px;padding:14px;font-size:17px;font-weight:700;min-height:44px}",
  ".cta.secondary{background:#fff;color:#0a5246;border:2px solid #0e6b5c}",
  "section{margin:26px 0}",
  ".media{margin:10px 0 14px}",
  ".media img{display:block;width:100%;height:auto;border-radius:10px;background:#e6ebe9}",
  ".media svg{display:block;width:100%;height:auto;border-radius:10px;border:1px solid #d6dedb;background:#fff}",
  "details{border:1px solid #d6dedb;border-radius:10px;padding:10px 14px;margin:8px 0;background:#fff}",
  "summary{cursor:pointer;font-weight:700;min-height:44px;display:flex;align-items:center}",
  ".company{background:#fff;border:1px solid #d6dedb;border-radius:12px;padding:16px}",
  ".company .name{font-weight:700;font-size:17px}",
  ".company .contact{color:#4a5b5e;white-space:pre-wrap;word-break:break-all}",
  ".tel{display:block;margin-top:12px}",
  ".inquiry{background:#fff;border:1px solid #d6dedb;border-radius:12px;padding:16px}",
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
  "  .bar{display:grid;grid-template-columns:1fr 1fr;gap:8px;position:fixed;bottom:0;left:0;right:0;padding:10px 12px calc(10px + env(safe-area-inset-bottom));background:rgba(255,255,255,.96);border-top:1px solid #d6dedb;backdrop-filter:saturate(1.2) blur(6px)}",
  "  .bar.single{grid-template-columns:1fr}",
  "  .bar .cta{padding:12px;font-size:16px}",
  "}",
  "@media (min-width: 768px){",
  "  main{max-width:760px;padding:24px 0 64px}",
  "  .hero{border-radius:14px}",
  "  .wrap{padding:24px 8px}",
  "  h1{font-size:30px}",
  "  .cta{max-width:420px;margin:0 auto}",
  "}",
  "@media (prefers-reduced-motion: reduce){*{scroll-behavior:auto!important;transition:none!important}}",
  "html{scroll-behavior:smooth}",
].join("\n");

function img(image: LpImage, cls: string, alt: string, priority = false): string {
  const loadAttrs = priority ? `loading="eager" fetchpriority="high"` : `loading="lazy"`;
  return `<img class="${cls}" src="/lp-assets/${escapeHtml(image.publicId)}" width="${image.width}" height="${image.height}" alt="${escapeHtml(alt)}" ${loadAttrs} decoding="async" />`;
}

function paragraphs(ps: string[]): string {
  return ps.map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br />")}</p>`).join("");
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

export function renderLpPage(input: LpRenderInput): string {
  const ctaTarget = input.form ? INQUIRY_SECTION_ID : CONTACT_ID;
  const cta = `<a class="cta" href="#${ctaTarget}">${escapeHtml(LP_CTA_LABEL)}</a>`;
  const telHref = input.company.phone ? `tel:${escapeHtml(input.company.phone)}` : null;
  const telBtn = telHref ? `<a class="cta secondary tel" href="${telHref}" data-phone-tap="1">電話で相談する</a>` : "";
  const sections = input.sections.map((s) => {
    let media = "";
    if (s.media?.kind === "asset") media = `<div class="media">${img(s.media.image, "", s.heading)}</div>`;
    else if (s.media?.kind === "figure") media = `<div class="media">${renderFigureSvg(s.media.figureKind)}</div>`;
    return `<section><h2>${escapeHtml(s.heading)}</h2>${media}${paragraphs(s.paragraphs)}</section>`;
  }).join("");
  const faq = input.faq.length === 0 ? "" : `<section><h2>よくある質問</h2>${input.faq.map((f) => `<details><summary>${escapeHtml(f.q)}</summary><p>${escapeHtml(f.a).replace(/\n/g, "<br />")}</p></details>`).join("")}</section>`;
  const company = `<section class="company" id="${CONTACT_ID}">` +
    (input.company.name ? `<div class="name">${escapeHtml(input.company.name)}</div>` : "") +
    (input.company.contact ? `<div class="contact">${escapeHtml(input.company.contact)}</div>` : "") +
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
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><meta name="robots" content="noindex,nofollow" /><meta name="referrer" content="strict-origin" /><title>${escapeHtml(input.headline)}</title><style>${CSS}</style></head><body>${band}<main>` +
    (input.hero ? img(input.hero, "hero", "", true) : "") +
    `<div class="wrap"><h1>${escapeHtml(input.headline)}</h1>` +
    (input.lead ? `<p class="lead">${escapeHtml(input.lead)}</p>` : "") +
    `<div style="margin:16px 0 8px">${cta}</div>` +
    paragraphs(input.intro) + sections + faq + (input.form ? formSection(input.form) : "") + company + unsub +
    `</div></main>${bar}${script}${submitGuard}</body></html>`;
}
