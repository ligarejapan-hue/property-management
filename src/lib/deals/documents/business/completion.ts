import { z } from "zod";
import { text } from "../../schema-parts";
import type { DealPartyView } from "../../view";
import { html, type SafeHtml } from "../html";
import { documentHtml } from "../layout";
import { checklistItemsOf } from "./checklist-doc";
import { CHECKLIST_TEXT_MAX, ymdJa } from "./contract-guide";
import { namesOf, partiesOf, propertyLabel, type BusinessDocContext, type ValueRow } from "./common";

/** 発行のときに直すもの: 引き渡した書類など(1行に1つ・設計 第2段階 §4.3)。 */
export const completionOptionsSchema = z.object({ handover: text(CHECKLIST_TEXT_MAX) }).strict();
export type CompletionOptions = z.output<typeof completionOptionsSchema>;

/** 初期値: 書類確認書(決済時)の「受け取るもの」(この取引に当てはまる項目)。 */
export function defaultHandover(c: BusinessDocContext): string | null {
  const labels = checklistItemsOf("settlement", c).filter((i) => i.group === "receive").map((i) => i.label);
  return labels.length ? labels.join("\n") : null;
}

export function completionMissing(c: BusinessDocContext): string[] {
  const d = c.deal;
  const out: string[] = [];
  if (!d.contractAt) out.push("契約日");
  if (!partiesOf(d, "seller").length) out.push("売主");
  if (!partiesOf(d, "buyer").length) out.push("買主");
  return out;
}

const BLANK_DATE = "　　年　　月　　日";
const lines = (s: string | null) => (s ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
// 登録した住所・氏名とは別に、手書きの署名の欄を空けて出す(設計 第2段階 §3.4)。
const SIGN = html`<td class="sign-blank">署名</td><td style="width:18mm;text-align:center;height:16mm">印</td>`;
const signRow = (role: string, p: DealPartyView): SafeHtml =>
  html`<tr><th style="width:12%">${role}</th><td>住所 ${p.address ?? ""}<br>氏名 ${p.name}</td>${SIGN}</tr>`;
const blankSignRow = (role: string): SafeHtml =>
  html`<tr><th style="width:12%">${role}</th><td>住所<br>氏名</td>${SIGN}</tr>`;

/** 取引完了確認書(仲介用・設計 第2段階 §4.3)。署名・押印の欄は空欄。角印は付けない。 */
export function buildCompletion(c: BusinessDocContext, o: CompletionOptions): { html: string; rows: ValueRow[] } {
  const d = c.deal;
  const sellers = partiesOf(d, "seller");
  const buyers = partiesOf(d, "buyer");
  const contractOn = ymdJa(d.contractAt);
  const settledOn = ymdJa(d.settlementAt);
  const items = lines(o.handover);
  const sc = d.costs.scrivener;
  const scrivener = [sc.name, sc.staff && `担当 ${sc.staff}`].filter(Boolean).join(" ") || null;
  const brokerage = d.businessType === "brokerage";
  const title = "取引完了確認書";
  const body = html`
<style>.sign-blank{width:48mm;vertical-align:top;font-size:8pt;color:#666}</style>
<h1>${title}</h1>
<div class="right">${settledOn ?? BLANK_DATE}</div>
<p class="greeting">売主 ${namesOf(sellers) ?? "　　　　　　"} と買主 ${namesOf(buyers) ?? "　　　　　　"} との間で${contractOn ?? BLANK_DATE}付で締結した下記不動産の売買契約について、残代金の授受、物件の引渡し及び所有権移転登記の申請手続きが本日完了したことを確認します。</p>
<h2>対象の不動産</h2>
<table><tr><th style="width:28%">物件</th><td>${propertyLabel(d)}</td></tr></table>
<h2>引き渡した書類など</h2>
${items.length ? html`<table>${items.map((i) => html`<tr><td>□ ${i}</td></tr>`)}</table>` : null}
<h2>署名・押印</h2>
<table>
${sellers.length ? sellers.map((p) => signRow("売主", p)) : blankSignRow("売主")}
${buyers.length ? buyers.map((p) => signRow("買主", p)) : blankSignRow("買主")}
${brokerage ? html`<tr><th>仲介業者</th><td>${c.company.address ?? ""}<br>${c.company.nameJa}${c.company.license ? html`<br>${c.company.license}` : null}</td><td></td><td style="text-align:center;height:16mm">印</td></tr>` : null}
</table>
<table style="margin-top:3mm"><tr><th style="width:16%">司法書士</th><td>${scrivener ?? ""}</td></tr></table>`;
  return {
    html: documentHtml({ title, font: "mincho", body }),
    rows: [
      { label: "売主", value: namesOf(sellers) }, { label: "買主", value: namesOf(buyers) },
      { label: "契約日", value: contractOn }, { label: "決済日", value: settledOn }, { label: "物件", value: propertyLabel(d) },
      { label: "引き渡した書類など", value: o.handover }, { label: "司法書士", value: scrivener },
    ],
  };
}
