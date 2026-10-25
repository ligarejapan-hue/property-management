import { z } from "zod";
import { isoDate, text } from "../../schema-parts";
import { DEAL_PARTY_ROLE_LABELS } from "../../constants";
import type { DealPartyView } from "../../view";
import { html, type SafeHtml } from "../html";
import { documentHtml } from "../layout";
import { DocOptionError } from "./receipts";
import { DASH, dateJa, dateTimeJa, headTable, propertyLabel, signBox, type BusinessDocContext, type Choice, type ValueRow } from "./common";

/** 委任する事項(決まった項目・計画の読み替え 1)。 */
export const POA_MATTERS = {
  valuation_cert: "固定資産評価証明書の取得",
  settlement: "売買代金の決済に関する一切の件",
  receive_balance: "残代金の受領",
  keys: "鍵の受け渡し",
} as const;
export type PoaMatter = keyof typeof POA_MATTERS;

export const poaOptionsSchema = z.object({
  /** 委任者 = 自社でない売主・買主の当事者 ID。 */
  principal: z.string().min(1).max(40),
  /** 受任者 = "self"(自社)か代理人の当事者 ID。 */
  agent: z.string().min(1).max(40),
  matters: z.array(z.enum(Object.keys(POA_MATTERS) as [PoaMatter, ...PoaMatter[]])).max(4),
  otherMatter: text(200),
  signedOn: isoDate.nullable(),
}).strict();
export type PoaOptions = z.output<typeof poaOptionsSchema>;

const principalsOf = (c: BusinessDocContext) =>
  c.deal.parties.filter((p) => (p.role === "seller" || p.role === "buyer") && !p.isSelf);
const agentsOf = (c: BusinessDocContext) => c.deal.parties.filter((p) => p.role === "agent" && !p.isSelf);

/** 選べる委任者・受任者と初期値(委任者=最初の売主、いなければ最初の買主・受任者=自社)。 */
export function poaChoices(c: BusinessDocContext): { principal: Choice[]; agent: Choice[]; initialPrincipal: string | null } {
  const ps = principalsOf(c);
  const first = ps.find((p) => p.role === "seller") ?? ps[0] ?? null;
  return {
    principal: ps.map((p) => ({ value: p.id, label: `${p.name}(${DEAL_PARTY_ROLE_LABELS[p.role as keyof typeof DEAL_PARTY_ROLE_LABELS]})` })),
    agent: [{ value: "self", label: `${c.company.nameJa}(自社)` }, ...agentsOf(c).map((p) => ({ value: p.id, label: p.name }))],
    initialPrincipal: first?.id ?? null,
  };
}

function personTable(name: string, address: string | null, representative: string | null): SafeHtml {
  return headTable([["住所", address], ["氏名(名称)", name], ...(representative ? [["代表者", representative] as [string, string]] : [])]);
}

/** 委任状(依頼書 4.3)。委任者の署名・実印の欄は空欄。角印は付けない。 */
export function buildPowerOfAttorney(c: BusinessDocContext, o: PoaOptions): { html: string; rows: ValueRow[] } {
  const principal = principalsOf(c).find((p) => p.id === o.principal);
  if (!principal) throw new DocOptionError("委任する人を選び直してください");
  let agent: { name: string; address: string | null; representative: string | null };
  if (o.agent === "self") {
    const rep = [c.settings.representativeTitle, c.settings.representativeName].filter(Boolean).join(" ") || null;
    agent = { name: c.company.nameJa, address: c.company.address || null, representative: rep };
  } else {
    const p: DealPartyView | undefined = agentsOf(c).find((x) => x.id === o.agent);
    if (!p) throw new DocOptionError("委任を受ける人を選び直してください");
    agent = { name: p.name, address: p.address, representative: p.partyType === "corporation" ? p.representative : null };
  }
  const matters: string[] = [...new Set(o.matters)].map((m) => POA_MATTERS[m]);
  if (o.otherMatter) matters.push(o.otherMatter);
  if (!matters.length) throw new DocOptionError("委任する事項を1つ以上選んでください", "NO_MATTER");

  const body = html`
<h1>委任状</h1>
<div class="right">${o.signedOn ? dateJa(o.signedOn) : "　　年　　月　　日"}</div>
<h2>代理人(委任を受ける人)</h2>
${personTable(agent.name, agent.address, agent.representative)}
<p>私は、上記の者を代理人と定め、次の不動産の売買について、下記の事項を委任します。</p>
${headTable([["物件", propertyLabel(c.deal)], ["決済日時", dateTimeJa(c.deal.settlementAt)]])}
<h2>委任する事項</h2>
<ol>${matters.map((m) => html`<li>${m}</li>`)}</ol>
<h2>委任者</h2>
${personTable(principal.name, principal.address, principal.partyType === "corporation" ? principal.representative : null)}
${signBox("署名・実印")}`;
  return {
    html: documentHtml({ title: "委任状", font: "mincho", body }),
    rows: [
      { label: "書類", value: "委任状" }, { label: "日付", value: o.signedOn }, { label: "代理人", value: agent.name },
      { label: "代理人の住所", value: agent.address }, { label: "物件", value: propertyLabel(c.deal) },
      ...matters.map((m, i) => ({ label: `委任する事項 ${i + 1}`, value: m })),
      { label: "委任者", value: principal.name }, { label: "委任者の住所", value: principal.address ?? DASH },
    ],
  };
}
