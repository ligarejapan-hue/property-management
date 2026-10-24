import { z } from "zod";
import { isoDate } from "../../schema-parts";
import { yen } from "../../calc/format";
import { pickRateContent } from "../../calc/deal-calc";
import { receiptStamp } from "../../calc/stamp";
import type { DealPartyView } from "../../view";
import { html, type SafeHtml } from "../html";
import { documentHtml } from "../layout";
import { dateJa, namesOf, partiesOf, propertyLabel, type BusinessDocContext, type ValueRow } from "./common";

export const RECEIPT_KINDS = {
  deposit_receipt: { label: "手付金領収書", purpose: "手付金" },
  balance_receipt: { label: "残金領収書", purpose: "残代金" },
  settlement_receipt: { label: "精算金領収書", purpose: "精算金" },
} as const;
export type ReceiptKind = keyof typeof RECEIPT_KINDS;

/** 発行のときに選ぶもの(計画の読み替え 2・4・5)。issuer = "self"(自社)か当事者の ID。 */
export const receiptOptionsSchema = z.object({
  issuer: z.string().min(1).max(40),
  /** 個人の発行者のときだけ必ず選ぶ(yes=非課税・no=課税)。 */
  exempt: z.enum(["yes", "no"]).nullable(),
  receivedOn: isoDate.nullable(),
}).strict();
export type ReceiptOptions = z.output<typeof receiptOptionsSchema>;

/** 選んだもので組み立てられないとき(発行の道は 422 にする)。 */
export class DocOptionError extends Error {
  constructor(message: string, readonly code = "DOC_OPTION_INVALID") {
    super(message);
  }
}

/** 金額: 手付金=手付金・残金=売買価格−手付金・精算金=精算書の差引(計画の読み替え 8)。無い・0 なら null。 */
export function receiptAmount(kind: ReceiptKind, c: BusinessDocContext): number | null {
  const s = c.calc.settlement;
  const n = kind === "deposit_receipt" ? c.deal.deposit : kind === "balance_receipt" ? s.remaining : s.ready ? s.net.amount : null;
  return n && n > 0 ? n : null;
}

/** 受け取る側(=領収書を出す側)と払う側。精算金は差引の向きで決まる。 */
export function receiptSides(kind: ReceiptKind, c: BusinessDocContext): { receiver: "seller" | "buyer"; payer: "seller" | "buyer" } | null {
  if (kind !== "settlement_receipt") return { receiver: "seller", payer: "buyer" };
  const dir = c.calc.settlement.net.direction;
  if (dir === "buyerToSeller") return { receiver: "seller", payer: "buyer" };
  if (dir === "sellerToBuyer") return { receiver: "buyer", payer: "seller" };
  return null;
}

export interface IssuerChoice { value: string; label: string; individual: boolean }

/** 選べる発行者: 自社と、受け取る側の当事者(自社の当事者は「自社」にまとめる)。初期値は自社の当事者があれば自社。 */
export function issuerChoices(kind: ReceiptKind, c: BusinessDocContext): { choices: IssuerChoice[]; initial: string } {
  const sides = receiptSides(kind, c);
  const receivers = sides ? partiesOf(c.deal, sides.receiver) : [];
  const choices: IssuerChoice[] = [
    { value: "self", label: `${c.company.nameJa}(自社)`, individual: false },
    ...receivers.filter((p) => !p.isSelf).map((p) => ({ value: p.id, label: p.name, individual: p.partyType === "individual" })),
  ];
  const initial = receivers.some((p) => p.isSelf) || !receivers.length ? "self" : receivers[0].id;
  return { choices, initial };
}

type Issuer = { kind: "self" } | { kind: "party"; party: DealPartyView };
function resolveIssuer(kind: ReceiptKind, c: BusinessDocContext, o: ReceiptOptions): Issuer {
  if (o.issuer === "self") return { kind: "self" };
  const sides = receiptSides(kind, c);
  const party = sides ? partiesOf(c.deal, sides.receiver).find((p) => p.id === o.issuer && !p.isSelf) : undefined;
  if (!party) throw new DocOptionError("発行者を選び直してください");
  return { kind: "party", party };
}

/** 個人の発行者(=非課税の判断が要る)か。 */
export function needsExemptDecision(kind: ReceiptKind, c: BusinessDocContext, issuer: string): boolean {
  if (issuer === "self") return false;
  const sides = receiptSides(kind, c);
  return sides ? partiesOf(c.deal, sides.receiver).some((p) => p.id === issuer && !p.isSelf && p.partyType === "individual") : false;
}

const BOX = "border:1px solid #333;padding:3mm;";

function issuerBlock(c: BusinessDocContext, issuer: Issuer): SafeHtml {
  if (issuer.kind === "self") {
    const co = c.company;
    const rep = [c.settings.representativeTitle, c.settings.representativeName].filter(Boolean).join(" ");
    return html`<div style="position:relative;margin:8mm 0 0 auto;width:95mm;min-height:28mm">
<div style="font-size:12pt">${co.nameJa}</div>
${co.address ? html`<div>${co.address}</div>` : null}
${rep ? html`<div>${rep}</div>` : null}
${c.seal ? html`<img src="${c.seal}" alt="" style="position:absolute;right:0;top:0;max-height:24mm;max-width:24mm;height:auto;width:auto">` : null}
</div>`;
  }
  // 当事者が発行するとき: 名前・住所だけ。自社の角印は付けない。署名・押印の欄は空欄(計画の読み替え 4)。
  const p = issuer.party;
  return html`<div style="margin:8mm 0 0 auto;width:95mm">
<div>${p.address ?? ""}</div>
<div style="font-size:12pt">${p.name}</div>
${p.partyType === "corporation" && p.representative ? html`<div>${p.representative}</div>` : null}
<div style="${BOX}margin-top:3mm;height:22mm">署名・押印</div>
</div>`;
}

/** 手付金・残金・精算金の領収書(依頼書 4.3・設計 §4.4)。 */
export function buildReceipt(kind: ReceiptKind, c: BusinessDocContext, o: ReceiptOptions): { html: string; rows: ValueRow[]; issuerLabel: string } {
  const def = RECEIPT_KINDS[kind];
  const amount = receiptAmount(kind, c);
  if (amount === null) throw new DocOptionError(`${def.purpose}の金額がありません`, "NO_AMOUNT");
  const issuer = resolveIssuer(kind, c, o);
  const individual = issuer.kind === "party" && issuer.party.partyType === "individual";
  if (individual && o.exempt === null) throw new DocOptionError("印紙が要るか(非課税か)を選んでください", "NEEDS_DECISION");
  const table = pickRateContent(c.rateRows, "stamp_receipt", o.receivedOn ?? c.today);
  const stamp = table ? receiptStamp(amount, table, individual && o.exempt === "yes" ? "yes" : "no").tax : null;
  const sides = receiptSides(kind, c)!;
  const payer = namesOf(partiesOf(c.deal, sides.payer));
  const breakdown = kind === "settlement_receipt" ? c.calc.settlement.rows.map((r) => r.label).join("・") : null;
  const issuerLabel = issuer.kind === "self" ? c.company.nameJa : issuer.party.name;
  // 0円は「非課税」(個人の事業用でない売買を選んだとき)か「不要」(5万円未満など)。
  const stampNone = individual && o.exempt === "yes" ? "非課税" : "印紙 不要";

  const body = html`
<h1>領収書</h1>
<div class="meta"><div class="customer">${payer ?? ""} 様</div><div class="right">${o.receivedOn ? dateJa(o.receivedOn) : "　　年　　月　　日"}</div></div>
<p style="${BOX}font-size:18pt;text-align:center;margin:6mm 0">金 ${yen(amount)} 円也</p>
<p>但し、${propertyLabel(c.deal)} の売買代金のうち${def.purpose}として${breakdown ? html`(内訳: ${breakdown})` : null}</p>
<p>上記の金額を正に領収いたしました。</p>
<div style="${BOX}width:30mm;text-align:center;font-size:9pt">${stamp === null ? "収入印紙" : stamp === 0 ? stampNone : html`収入印紙<br>${yen(stamp)}円`}</div>
${issuerBlock(c, issuer)}`;
  return {
    html: documentHtml({ title: def.label, font: "mincho", body }),
    issuerLabel,
    rows: [
      { label: "書類", value: def.label }, { label: "宛先", value: payer }, { label: "金額", value: amount },
      { label: "但し書き", value: `${propertyLabel(c.deal)} の売買代金のうち${def.purpose}として` },
      ...(breakdown ? [{ label: "内訳", value: breakdown }] : []),
      { label: "受領日", value: o.receivedOn }, { label: "収入印紙", value: stamp === 0 ? stampNone : stamp },
      { label: "発行者", value: issuerLabel },
    ],
  };
}
