import { html } from "../html";
import { documentHtml } from "../layout";
import { SELLER_SURVEY_FORM } from "../forms/seller-survey";
import { formValuesSchema } from "../forms/schema";
import { emptyFormValues } from "../forms/values";
import { formValueRows, renderFormHtml } from "../forms/render";
import type { FormValues } from "../forms/types";
import { DASH, dateJa, headTable, partiesOf, propertyLabel, type BusinessDocContext, type ValueRow } from "./common";

export const SELLER_SURVEY_TITLE = "売主属性調査書(社内用)";
export const sellerSurveyOptionsSchema = formValuesSchema(SELLER_SURVEY_FORM);

/** 初期値: 個人・法人と共有者だけ取引の売主から(設計 §4.2)。抵当権などは謄本の件数と意味がずれうるので入れない。 */
export function sellerSurveyDefaults(c: BusinessDocContext): FormValues {
  const sellers = partiesOf(c.deal, "seller");
  const types = new Set(sellers.map((p) => p.partyType));
  return {
    ...emptyFormValues(SELLER_SURVEY_FORM),
    sellerType: types.size === 1 ? [...types][0] : null,
    coOwners: sellers.length > 1 ? "yes" : sellers.length === 1 ? "no" : null,
  };
}

export function sellerSurveyMissing(c: BusinessDocContext): string[] {
  const out: string[] = [];
  if (partiesOf(c.deal, "seller").some((p) => !p.address)) out.push("売主の住所");
  if (!c.staff?.sales) out.push("営業担当");
  return out;
}

/**
 * 謄本の登記の状況(書類確認書と同じ読み方・名前は入れない)。
 * 権利の件数が 0 でも、謄本が無い・読めない・見る権限が無いことがあるので「無い」とは書かない。
 */
export function registryStatusText(c: BusinessDocContext): string {
  const n = c.registry?.activeRights ?? 0;
  return [n > 0 ? `抹消の手続きが要る権利 ${n}件` : "謄本で確かめてください", c.registry?.caution ?? null].filter(Boolean).join(" / ");
}

const share = (n: number | null, d: number | null) => (n && d ? `${n}/${d}` : "");

/** 売主属性調査書(社内用・設計 第2段階 §4.2)。項目は項目の表から(選ばなければ □ の空欄)。 */
export function buildSellerSurvey(c: BusinessDocContext, o: FormValues): { html: string; rows: ValueRow[] } {
  const d = c.deal;
  const sellers = partiesOf(d, "seller");
  const head: [string, string | null][] = [
    ["取引番号", d.dealNo], ["物件", propertyLabel(d)], ["記入日", dateJa(c.today)], ["営業担当", c.staff?.sales ?? null],
    ["謄本の登記の状況", registryStatusText(c)],
  ];
  const body = html`
<h1>${SELLER_SURVEY_TITLE}</h1>
<p class="right" style="font-size:8.5pt">社内用の書類です(お客様にはお渡ししません)</p>
${headTable(head)}
<h2>売主</h2>
<table><tr><th style="width:30%">名前</th><th>住所</th><th style="width:14%">持分</th></tr>
${sellers.map((p) => html`<tr><td>${p.name}</td><td>${p.address ?? ""}</td><td>${share(p.shareNum, p.shareDen)}</td></tr>`)}</table>
${renderFormHtml(SELLER_SURVEY_FORM, o)}
<table style="margin-top:6mm"><tr><th style="width:33%">営業担当</th><th style="width:33%">業務担当</th><th>承認</th></tr>
<tr><td style="height:16mm"></td><td></td><td></td></tr></table>`;
  return {
    html: documentHtml({ title: SELLER_SURVEY_TITLE, font: "gothic", body }),
    rows: [
      { label: "書類", value: SELLER_SURVEY_TITLE },
      ...head.map(([label, value]) => ({ label, value: value ?? DASH })),
      { label: "売主", heading: true },
      ...sellers.map((p, i) => ({ label: `売主${i + 1}`, value: [p.name, p.address, share(p.shareNum, p.shareDen)].filter(Boolean).join(" / ") })),
      ...formValueRows(SELLER_SURVEY_FORM, o),
    ],
  };
}
