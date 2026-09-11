/**
 * 公開LP(設計 2026-09-08 §2.4)。React を使わない純関数。unsubscribe-page.ts と同じ作り。
 *  - 全ての動的値は escapeHtml。図(renderFigureSvg)だけは自前生成の SVG としてそのまま埋める。
 *  - CSS は inline・外部読み込みなし。スマホ(〜767px)=1列+画面下の固定バー、PC(768px〜)=中央1列 760px。
 *  - <script> は電話タップ送信の固定文字列1本(live のみ)。token は JSON.stringify で埋める。
 */
import { escapeHtml } from "./templates/index";
import { renderFigureSvg } from "./lp-figures";
import type { LpRenderInput, LpImage } from "./lp-render-input";
export { PUBLIC_PAGE_HEADERS } from "./unsubscribe-page";

export const LP_CTA_LABEL = "無料査定を申し込む";
const CONTACT_ID = "contact";

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

function img(image: LpImage, cls: string, alt: string): string {
  return `<img class="${cls}" src="/lp-assets/${escapeHtml(image.publicId)}" width="${image.width}" height="${image.height}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async" />`;
}

function paragraphs(ps: string[]): string {
  return ps.map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br />")}</p>`).join("");
}

export function renderLpPage(input: LpRenderInput): string {
  const cta = `<a class="cta" href="#${CONTACT_ID}">${escapeHtml(LP_CTA_LABEL)}</a>`;
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
    `<p style="margin-top:10px">無料査定のお申し込み・ご相談は、お電話で承ります。</p>${telBtn}</section>`;
  const unsub = input.unsubscribeUrl ? `<p class="unsub">今後このようなお手紙が不要な方は <a href="${escapeHtml(input.unsubscribeUrl)}">こちら(配信停止)</a></p>` : "";
  const band = input.mode === "preview" ? `<div class="band">プレビュー ── この宛先はまだ送付前です。お申し込みは受け付けません</div>` : "";
  const bar = telHref
    ? `<div class="bar">${cta}<a class="cta secondary" href="${telHref}" data-phone-tap="1">電話</a></div>`
    : `<div class="bar single">${cta}</div>`;
  const script = input.mode === "live" && input.phoneTapToken && telHref
    ? (() => {
        const url = JSON.stringify(`/t/${input.phoneTapToken}/phone-tap`);
        return `<script>(function(){document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("[data-phone-tap]"):null;if(!a)return;try{if(navigator.sendBeacon){navigator.sendBeacon(${url})}else{fetch(${url},{method:"POST",keepalive:true}).catch(function(){})}}catch(_){}});})();</script>`;
      })()
    : "";
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><meta name="robots" content="noindex,nofollow" /><meta name="referrer" content="no-referrer" /><title>${escapeHtml(input.headline)}</title><style>${CSS}</style></head><body>${band}<main>` +
    (input.hero ? img(input.hero, "hero", "") : "") +
    `<div class="wrap"><h1>${escapeHtml(input.headline)}</h1>` +
    (input.lead ? `<p class="lead">${escapeHtml(input.lead)}</p>` : "") +
    `<div style="margin:16px 0 8px">${cta}</div>` +
    paragraphs(input.intro) + sections + faq + company + unsub +
    `</div></main>${bar}${script}</body></html>`;
}
