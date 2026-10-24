import type { CompanyProfile } from "@/lib/sales-sheet/company-profile-store";
import { html, raw, type HtmlValue, type SafeHtml } from "./html";

/** 書類の書体。表と数字はゴシック、領収書・委任状・お知らせは明朝(設計 §4.2)。サーバーに入っている書体を名前で使う。 */
export const GOTHIC = `"BIZ UDGothic","BIZ UDゴシック","Yu Gothic","Meiryo",sans-serif`;
export const MINCHO = `"BIZ UDMincho","BIZ UD明朝","Yu Mincho",serif`;

const BASE_CSS = `
@page { size: A4 portrait; margin: 14mm 14mm 16mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; color: #111; }
body { font-size: 10pt; line-height: 1.5; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.doc { width: 182mm; margin: 0 auto; }
@media screen { body { background: #e5e7eb; padding: 8mm 0; } .doc { background: #fff; padding: 14mm; width: 210mm; min-height: 297mm; box-shadow: 0 1px 4px rgba(0,0,0,.15); } }
h1 { font-size: 16pt; text-align: center; letter-spacing: .2em; margin: 0 0 4mm; }
h2 { font-size: 11pt; margin: 5mm 0 1.5mm; padding-left: 2mm; border-left: 3px solid #333; }
table { width: 100%; border-collapse: collapse; page-break-inside: auto; }
tr { page-break-inside: avoid; }
th, td { border: 1px solid #999; padding: 1.2mm 2mm; vertical-align: top; }
th { background: #f3f4f6; font-weight: normal; text-align: left; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
tr.total th, tr.total td { font-weight: bold; background: #f9fafb; }
.meta { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 3mm; }
.customer { font-size: 13pt; border-bottom: 1px solid #333; padding: 0 2mm 1mm; min-width: 70mm; }
.right { text-align: right; }
.notes { margin: 2mm 0 0; padding-left: 5mm; font-size: 8.5pt; color: #333; }
.company { margin-top: 8mm; text-align: right; font-size: 9pt; line-height: 1.6; }
.company .name { font-size: 11pt; }
.company .logo { display: block; margin: 0 0 1.5mm auto; max-height: 14mm; max-width: 50mm; height: auto; width: auto; }
.greeting, .remarks { white-space: pre-wrap; margin: 3mm 0; }
.remarks { font-size: 8.5pt; color: #333; }
`;

/** 書類に埋め込めるロゴの形(PNG・JPEG の data: の URL)。それ以外は出さない(外の URL を読ませない)。 */
const LOGO_DATA_URI = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+=*$/;

/** 会社欄。ロゴは取引の設定で登録したもの(縦横比は保ったまま、枠の中に収める)。 */
export function companyBlock(c: CompanyProfile, logo?: string | null): SafeHtml {
  const tel = [c.tel && `TEL ${c.tel}`, c.fax && `FAX ${c.fax}`].filter(Boolean).join(" / ");
  return html`<div class="company">
${logo && LOGO_DATA_URI.test(logo) ? html`<img class="logo" src="${logo}" alt="">` : null}
<div class="name">${c.nameJa}</div>
${c.license ? html`<div>${c.license}</div>` : null}
${c.address ? html`<div>${c.address}</div>` : null}
${tel ? html`<div>${tel}</div>` : null}
</div>`;
}

/** A4 縦の書類1つ分の完全な HTML。外の URL は読まない(PDF を作るブラウザも外を読まない設定)。 */
export function documentHtml(opts: { title: string; font?: "gothic" | "mincho"; body: HtmlValue }): string {
  const font = opts.font === "mincho" ? MINCHO : GOTHIC;
  return `<!DOCTYPE html>${html`<html lang="ja"><head><meta charset="utf-8"><title>${opts.title}</title>
<style>${raw(BASE_CSS)} body { font-family: ${raw(font)}; }</style></head>
<body><div class="doc">${opts.body}</div></body></html>`.__html}`;
}
