import { html, raw } from "../html";
import { documentHtml } from "../layout";
import { DISCLOSURE_FORM, DISCLOSURE_KIND_LABELS, type DisclosureKind } from "../forms/disclosure";
import { emptyFormValues } from "../forms/values";
import { formValueRows, renderFormHtml } from "../forms/render";
import type { FormValues } from "../forms/types";
import { DISCLOSURE_HOUSE_SOURCE } from "../texts/disclosure-house";
import { DISCLOSURE_UNIT_SOURCE } from "../texts/disclosure-unit";
import type { DisclosureSource } from "../texts/disclosure-types";
import type { BusinessDocContext, ValueRow } from "./common";

const SOURCES: Record<DisclosureKind, DisclosureSource> = { house: DISCLOSURE_HOUSE_SOURCE, unit: DISCLOSURE_UNIT_SOURCE };

/** 書式の頭の文と署名の文(全宅連の書式のセルの文字のまま・テストで突き合わせる)。 */
export const DISCLOSURE_HEAD_TEXTS: Record<DisclosureKind, string[]> = {
  house: [
    "売買物件の状況(現況更地は①～⑪の記入不要、建物解体後の更地渡しは①～③、⑦～⑪の記入不要",
    "売主は、売主が現在知っている売買物件の状況について、以下のとおり買主に説明いたします。",
    "物件の状況　本物件は通常の経年変化があるほか、下記のとおりの状況であります。",
    "本物件の状況が上記のとおりであることを売主は、買主に告知しました。",
    "上記のとおり、売主より告知を受けました。",
  ],
  unit: [
    "売主は、売主が現在知っている売買物件の状況について、以下のとおり買主に説明いたします。",
    "本物件の状況が上記のとおりであることを売主は、買主に告知しました。",
    "上記のとおり、売主より告知を受けました。",
  ],
};

const CSS = `.sign td{height:12mm;vertical-align:bottom}
.guide p{white-space:pre-wrap;margin:1.5mm 0}
.page{page-break-before:always}`;

const kindOf = (o: FormValues): DisclosureKind => (o.kind === "unit" ? "unit" : "house");

/** 書式の頭の「物件名」(物件名・号室。無ければ所在地)。 */
function propertyName(c: BusinessDocContext): string | null {
  const s = c.deal.propertySnapshot;
  return [s.buildingName, s.roomNo && `${s.roomNo}号室`].filter(Boolean).join(" ") || s.address || null;
}

export function disclosureDefaults(c: BusinessDocContext): FormValues {
  const base = c.settings.propertyKinds.find((k) => k.key === c.deal.propertyKind)?.base ?? null;
  return { ...emptyFormValues(DISCLOSURE_FORM), kind: base === "unit" ? "unit" : "house", withGuide: "付ける" };
}

export function disclosureMissing(c: BusinessDocContext): string[] {
  return propertyName(c) ? [] : ["物件名"];
}

/** 物件状況確認書(告知書・設計 第2段階 §4.7)。売主・買主の名前は署名の欄なので空欄。 */
export function buildDisclosure(c: BusinessDocContext, o: FormValues): { html: string; rows: ValueRow[] } {
  const kind = kindOf(o);
  const src = SOURCES[kind];
  const texts = DISCLOSURE_HEAD_TEXTS[kind];
  const title = `物件状況確認書（告知書／${DISCLOSURE_KIND_LABELS[kind]}）`;
  const [notify, received] = texts.slice(-2);
  const intro = texts.slice(0, -2);
  const name = propertyName(c);
  const guide = o.withGuide === "付ける" ? html`
<div class="page guide"><h1 style="font-size:13pt;letter-spacing:0">${src.coverTitle}</h1>${src.cover.map((p) => html`<p>${p}</p>`)}</div>
<div class="page guide"><h1 style="font-size:13pt;letter-spacing:0">${src.guideTitle}</h1>
${src.guide.map((b) => (b.kind === "note" ? html`<p>${b.text}</p>` : html`<table><tr><th style="width:30%">${b.item}</th><td style="white-space:pre-wrap">${b.text}</td></tr></table>`))}</div>` : null;
  const body = html`<style>${raw(CSS)}</style>
<h1 style="font-size:14pt;letter-spacing:0">${title}</h1>
<div class="right">（物件名：${name ?? ""}）</div>
${intro.map((p) => html`<p>${p}</p>`)}
${renderFormHtml(DISCLOSURE_FORM, o)}
<p class="right" style="margin-top:4mm">年　　　月　　　日</p>
<p>${notify}</p>
<table class="sign"><tr><th style="width:18%">＜売主＞</th><td>氏名</td><td style="width:14mm;text-align:center">印</td></tr></table>
<p>${received}</p>
<table class="sign"><tr><th style="width:18%">＜買主＞</th><td>氏名</td><td style="width:14mm;text-align:center">印</td></tr></table>
${guide}`;
  return {
    html: documentHtml({ title, font: "mincho", body }),
    rows: [{ label: "書類", value: title }, { label: "物件名", value: name }, ...formValueRows(DISCLOSURE_FORM, o)],
  };
}
