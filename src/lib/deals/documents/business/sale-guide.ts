import { html } from "../html";
import { companyBlock, documentHtml } from "../layout";
import { SALE_GUIDE } from "../texts/sale-guide";
import type { BusinessDocContext, ValueRow } from "./common";

/** 媒介契約の前の説明書(売却用・設計 第2段階 §4.6)。全宅連の文面をそのまま1ページで出し、会社名と担当者を添える。 */
export function buildSaleGuide(c: BusinessDocContext): { html: string; rows: ValueRow[] } {
  const g = SALE_GUIDE;
  const staff = c.staff?.sales ?? null;
  const list = (title: string, xs: readonly string[]) => html`<div style="flex:1;border:1px solid #999;padding:2mm 3mm"><p style="margin:0 0 1mm;font-weight:bold">${title}</p>${xs.map((x) => html`<div>${x}</div>`)}</div>`;
  const body = html`
<h1 style="font-size:13pt;letter-spacing:0">${g.title}</h1>
${g.intro.map((p) => html`<p class="greeting">${p}</p>`)}
<h2>${g.flowTitle}</h2>
<div style="display:flex;gap:4mm">${list(g.saleTitle, g.sale)}${list(g.relatedTitle, g.related)}</div>
${companyBlock(c.company, c.logo)}
${staff ? html`<div class="right">担当 ${staff}</div>` : null}`;
  return {
    html: documentHtml({ title: g.title, font: "mincho", body }),
    rows: [{ label: "書類", value: g.title }, { label: "担当", value: staff }],
  };
}
