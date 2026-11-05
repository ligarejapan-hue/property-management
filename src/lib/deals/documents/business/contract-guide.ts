import { z } from "zod";
import { text } from "../../schema-parts";
import { CHECKLIST_TEXT_MAX } from "../../checklist";
import { jstDateString } from "../../datetime";
import { html } from "../html";
import { companyBlock, documentHtml } from "../layout";
import { checklistItemsOf } from "./checklist-doc";
import { dateJa, dateTimeJa, headTable, money, namesOf, partiesOf, propertyLabel, type BusinessDocContext, type Choice, type ValueRow } from "./common";

export { CHECKLIST_TEXT_MAX };

/** 発行のときに選ぶもの(設計 第2段階 §4.1)。 */
export const contractGuideOptionsSchema = z.object({
  addressee: z.enum(["seller", "buyer"]),
  belongings: text(CHECKLIST_TEXT_MAX),
  notes: text(500),
}).strict();
export type ContractGuideOptions = z.output<typeof contractGuideOptionsSchema>;

const ADDRESSEE_LABELS = { seller: "売主様", buyer: "買主様" } as const;

/** ISO の日時 → 日本時間の「2026年5月1日」。無ければ null。 */
export const ymdJa = (iso: string | null): string | null => (iso ? dateJa(jstDateString(new Date(iso))) : null);

/** 宛先の初期値: 買主側の仲介なら買主、それ以外は売主。 */
export function defaultAddressee(c: BusinessDocContext): "seller" | "buyer" {
  return c.deal.tradeSide === "buyer" ? "buyer" : "seller";
}

export function addresseeChoices(c: BusinessDocContext): Choice[] {
  return (["seller", "buyer"] as const).map((r) => ({ value: r, label: `${ADDRESSEE_LABELS[r]}(${namesOf(partiesOf(c.deal, r)) ?? "未入力"})` }));
}

/** 宛先が法人、または個人で取引に代理人がいるときに足すもの(2026-11-05 発注者)。 */
const PROXY_BELONGINGS = ["委任状", "実印"];

/**
 * お持ちいただくものの初期値: 書類確認書(契約時)の「持参するもの」(この取引に当てはまる項目・1行に1つ)。
 * 宛先の当事者が法人、または個人で取引に代理人がいれば、委任状と実印も足す(すでにあれば重ねない)。
 */
export function defaultContractBelongings(c: BusinessDocContext, addressee: "seller" | "buyer" = defaultAddressee(c)): string | null {
  const labels = checklistItemsOf("contract", c).filter((i) => i.group === "bring").map((i) => i.label);
  const hasAgent = c.deal.parties.some((p) => p.role === "agent");
  if (partiesOf(c.deal, addressee).some((p) => p.partyType === "corporation" || hasAgent)) {
    for (const x of PROXY_BELONGINGS) if (!labels.includes(x)) labels.push(x);
  }
  return labels.length ? labels.join("\n") : null;
}

const ROLE_LABELS = { seller: "売主", buyer: "買主" } as const;

/** 当事者のいない宛先(画面で宛先を選び直したとき、出す前の確認に足す)。 */
export function addresseeMissingChoices(c: BusinessDocContext): Choice[] {
  return (["seller", "buyer"] as const).filter((r) => !partiesOf(c.deal, r).length).map((r) => ({ value: r, label: ROLE_LABELS[r] }));
}

/** 出す前の確認: 契約日時・契約場所・宛先の当事者(宛先は前回の入力があればそれ、無ければ初期値)。 */
export function contractGuideMissing(c: BusinessDocContext, addressee?: unknown): string[] {
  const d = c.deal;
  const out: string[] = [];
  if (!d.contractAt) out.push("契約日時");
  if (!d.contractPlace) out.push("契約場所");
  const to = addressee === "seller" || addressee === "buyer" ? addressee : defaultAddressee(c);
  if (!partiesOf(d, to).length) out.push(ROLE_LABELS[to]);
  return out;
}

const lines = (s: string | null) => (s ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
const LATER = "(決まりしだいご案内します)";

/** 契約のご案内(設計 第2段階 §4.1)。宛先・日時・場所・手付金・お持ちいただくもの・この後の流れ・会社と担当。 */
export function buildContractGuide(c: BusinessDocContext, o: ContractGuideOptions): { html: string; rows: ValueRow[] } {
  const d = c.deal;
  const to = namesOf(partiesOf(d, o.addressee));
  const title = "不動産売買契約のご案内";
  const items = lines(o.belongings);
  const flow: [string, string | null][] = [
    ["売買契約のご締結(手付金の授受)", ymdJa(d.contractAt)],
    ["残代金のお支払い・お引渡し(決済)", ymdJa(d.settlementAt)],
  ];
  const staff = c.staff?.sales ?? null;
  const body = html`
<h1>${title}</h1>
<div class="meta"><div class="customer">${to ?? ""} 様</div><div class="right">${dateJa(c.today)}</div></div>
<p class="greeting">拝啓　平素は格別のお引き立てを賜り、厚く御礼申し上げます。
さて、不動産の売買契約につきまして、下記のとおりご案内申し上げます。</p>
<p class="right">敬具</p>
<p style="text-align:center">記</p>
${headTable([
  ["物件", propertyLabel(d)], ["日時", d.contractAt ? dateTimeJa(d.contractAt) : null], ["場所", d.contractPlace],
  ["手付金", d.deposit === null ? null : money(d.deposit)],
])}
<h2>お持ちいただくもの</h2>
${items.length ? html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>` : null}
<h2>この後の流れ</h2>
<table>${flow.map(([k, v]) => html`<tr><th style="width:28%">${v ?? LATER}</th><td>${k}</td></tr>`)}</table>
${o.notes ? html`<h2>ご連絡事項</h2><p class="remarks">${o.notes}</p>` : null}
<p>ご不明な点は、お気軽に担当までお問い合わせください。</p>
<p class="right">以上</p>
${companyBlock(c.company, c.logo)}
${staff ? html`<div class="right">担当 ${staff}</div>` : null}`;
  return {
    html: documentHtml({ title, font: "mincho", body }),
    rows: [
      { label: "宛先", value: to }, { label: "物件", value: propertyLabel(d) },
      { label: "契約日時", value: d.contractAt ? dateTimeJa(d.contractAt) : null }, { label: "契約場所", value: d.contractPlace },
      { label: "手付金", value: d.deposit }, { label: "お持ちいただくもの", value: o.belongings },
      { label: "決済予定日", value: ymdJa(d.settlementAt) }, { label: "ご連絡事項", value: o.notes }, { label: "担当", value: staff },
    ],
  };
}
