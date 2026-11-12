import { z } from "zod";
import { isoDate } from "../../schema-parts";
import { yen } from "../../calc/format";
import { pickRateContent } from "../../calc/deal-calc";
import { receiptStamp } from "../../calc/stamp";
import type { DealPartyView } from "../../view";
import { html, type SafeHtml } from "../html";
import { documentHtml } from "../layout";
import { jstDateString } from "../../datetime";
import { dateJa, namesOf, partiesOf, propertyLabel, type BusinessDocContext, type ValueRow } from "./common";
import { NEEDS_SELLER_PARTY } from "./receipt-issuer";

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

/** 自社を発行者に選べるか。手付金・残金は自社では出さない(別の会計システム・2026-11-06 発注者)。精算金は今のまま。 */
const selfIssuerAllowed = (kind: ReceiptKind) => kind === "settlement_receipt";

/**
 * 選べる発行者: 受け取る側の当事者(自社の当事者は除く)。精算金だけ自社も選べる(自社の当事者は「自社」にまとめる)。
 * 初期値: 精算金は自社の当事者があれば自社・それ以外は最初の当事者。手付金・残金で選べる人がいなければ ""(発行は止める)。
 */
export function issuerChoices(kind: ReceiptKind, c: BusinessDocContext): { choices: IssuerChoice[]; initial: string } {
  const sides = receiptSides(kind, c);
  const receivers = sides ? partiesOf(c.deal, sides.receiver) : [];
  const parties = receivers.filter((p) => !p.isSelf).map((p) => ({ value: p.id, label: p.name, individual: p.partyType === "individual" }));
  if (!selfIssuerAllowed(kind)) return { choices: parties, initial: parties[0]?.value ?? "" };
  const choices: IssuerChoice[] = [{ value: "self", label: `${c.company.nameJa}(自社)`, individual: false }, ...parties];
  const initial = receivers.some((p) => p.isSelf) || !receivers.length ? "self" : receivers[0].id;
  return { choices, initial };
}

/** 発行を止める項目: 手付金・残金で売主の当事者(自社を除く)がいない。 */
export function receiptIssuerBlocking(kind: ReceiptKind, c: BusinessDocContext): string[] {
  return !selfIssuerAllowed(kind) && !issuerChoices(kind, c).choices.length ? [NEEDS_SELLER_PARTY] : [];
}

type Issuer = { kind: "self" } | { kind: "party"; party: DealPartyView };
function resolveIssuer(kind: ReceiptKind, c: BusinessDocContext, o: ReceiptOptions): Issuer {
  if (o.issuer === "self") {
    if (!selfIssuerAllowed(kind)) throw new DocOptionError(`${RECEIPT_KINDS[kind].label}は自社では発行できません。売主の当事者を選んでください`);
    return { kind: "self" };
  }
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

/** 西暦の YYYY-MM-DD → 和暦(令和・平成・昭和。1年は「元年」)。 */
export function warekiJa(ymd: string): string {
  const y = Number(ymd.slice(0, 4));
  const [era, n] = ymd >= "2019-05-01" ? ["令和", y - 2018] : ymd >= "1989-01-08" ? ["平成", y - 1988] : ["昭和", y - 1925];
  return `${era}${n === 1 ? "元" : n}年${Number(ymd.slice(5, 7))}月${Number(ymd.slice(8, 10))}日`;
}

const BLANK_DATE = "　　年　　月　　日";
/** 手で書き入れる空欄(全角の空白5つ)。 */
const BLANK = "　　　　　";

/** 新しいひな形の物件の表示。区分=マンション名と部屋番号・それ以外(種類が未選択も)=所在地と地番。 */
function partyReceiptProperty(c: BusinessDocContext) {
  const s = c.deal.propertySnapshot;
  if (c.calc.kindBase === "unit") {
    return { label: "物件", sep: "　", parts: [["マンション名", s.buildingName], ["部屋番号", s.roomNo]] as const };
  }
  return { label: "所在地", sep: " ", parts: [["所在地", s.address], ["地番", s.lotNumber]] as const };
}

/**
 * 当事者が発行する手付金・残金の領収書で、空欄で出る部分の知らせ(発行は止めない)。
 * 精算金領収書は今の書式のままなので出さない。自社発行のときは画面が出さない。
 */
export function partyReceiptNotes(kind: ReceiptKind, c: BusinessDocContext): string[] {
  if (kind === "settlement_receipt") return [];
  const out = c.deal.contractAt ? [] : ["契約日が未入力のため、日付は空欄で出ます"];
  for (const [name, v] of partyReceiptProperty(c).parts) if (!v) out.push(`${name}が未入力のため、空欄で出ます`);
  return out;
}

const PARTY_CSS = `
@page { size: A4 portrait; margin: 0; }
.doc { position: relative; width: 210mm; height: 296mm; margin: 0 auto; padding: 0; overflow: hidden; }
@media screen { .doc { padding: 0; min-height: 0; } }
.rc-outer { position: absolute; inset: 12mm; border: 1mm double #000; }
.rc-inner { position: absolute; inset: 15mm; border: 0.3mm solid #000; }
.rc-body { position: absolute; inset: 25mm; font-size: 11pt; color: #000; }
.rc-top { text-align: right; font-size: 10.5pt; }
.rc-title { font-size: 26pt; letter-spacing: .6em; text-indent: .6em; margin: 12mm 0 10mm; }
.rc-to { display: flex; justify-content: space-between; width: 110mm; border-bottom: 0.4mm solid #000; font-size: 16pt; padding: 0 2mm 1mm; }
.rc-amount { display: flex; align-items: center; justify-content: center; height: 22mm; border-top: 1.2mm solid #000; border-bottom: 1.2mm solid #000; font-size: 24pt; font-weight: bold; margin: 10mm 0 8mm; }
.rc-body p { margin: 0 0 3mm; }
.rc-ki { text-align: center; font-size: 12pt; margin: 8mm 0 4mm; }
.rc-k { display: inline-block; width: 18mm; }
.rc-bottom { position: absolute; left: 0; right: 0; bottom: 0; display: flex; justify-content: space-between; align-items: flex-end; }
.rc-stamp { width: 30mm; height: 36mm; border: 0.3mm solid #000; display: flex; align-items: center; justify-content: center; text-align: center; font-size: 9pt; padding: 2mm; }
.rc-issuer { width: 95mm; }
.rc-issuer .name { font-size: 13pt; }
.rc-sign { border: 0.3mm solid #000; padding: 2mm 3mm; margin-top: 3mm; height: 22mm; font-size: 9pt; }
`;

/** 手付金・残金の領収書(売主の当事者が発行・A4縦・黒一色・2026-11-05 発注者の見本)。 */
function buildPartyReceipt(
  kind: ReceiptKind, c: BusinessDocContext, o: ReceiptOptions, a: { amount: number; payer: string | null; stamp: number | null; exempt: boolean; party: DealPartyView },
): { html: string; rows: ValueRow[]; issuerLabel: string } {
  const def = RECEIPT_KINDS[kind];
  const contractOn = c.deal.contractAt ? warekiJa(jstDateString(new Date(c.deal.contractAt))) : null;
  // 受領日も和暦(但し書きの契約日とそろえる・2026-11-05 発注者)。ほかの書類の日付は西暦のまま。
  const receivedOn = o.receivedOn ? warekiJa(o.receivedOn) : null;
  const tadashi = `但し　${contractOn ?? BLANK_DATE}付下記記載の不動産売買契約に基づく売買代金（${def.purpose}）として`;
  const prop = partyReceiptProperty(c);
  const shown = prop.parts.map(([, v]) => v || BLANK).join(prop.sep);
  const propValue = prop.parts.map(([, v]) => v).filter(Boolean).join(prop.sep) || null;
  const stampNone = a.exempt ? "非課税（営業に関しない受取書）" : "印紙 不要";
  const p = a.party;
  const body = html`<div class="rc-outer"></div><div class="rc-inner"></div>
<div class="rc-body">
<div class="rc-top">${receivedOn ?? BLANK_DATE}</div>
<h1 class="rc-title">領 収 書</h1>
<div class="rc-to"><span>${a.payer ?? ""}</span><span>様</span></div>
<div class="rc-amount">金 ${yen(a.amount)} 円也</div>
<p>${tadashi}</p>
<p>上記の金額を正に領収いたしました。</p>
<div class="rc-ki">記</div>
<p><span class="rc-k">${prop.label}</span>${shown}</p>
<div class="rc-bottom">
<div class="rc-stamp">${a.stamp === null ? "収入印紙" : a.stamp === 0 ? stampNone : html`収入印紙<br>${yen(a.stamp)}円`}</div>
<div class="rc-issuer">
<div>${p.address ?? ""}</div>
<div class="name">${p.name}</div>
${p.partyType === "corporation" && p.representative ? html`<div>${p.representative}</div>` : null}
<div class="rc-sign">署名・押印</div>
</div>
</div>
</div>`;
  return {
    html: documentHtml({ title: def.label, font: "mincho", body, css: PARTY_CSS }),
    issuerLabel: p.name,
    rows: [
      { label: "書類", value: def.label }, { label: "宛先", value: a.payer }, { label: "金額", value: a.amount },
      { label: "但し書き", value: tadashi }, { label: "契約日", value: contractOn }, { label: prop.label, value: propValue },
      { label: "受領日", value: receivedOn }, { label: "収入印紙", value: a.stamp === 0 ? stampNone : a.stamp },
      { label: "発行者", value: p.name },
    ],
  };
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
  // 非課税を選んだら、表の有無に関わらず 0(=「非課税」と出す・@codex)。
  const exempt = individual && o.exempt === "yes";
  const stamp = exempt ? 0 : table ? receiptStamp(amount, table, "no").tax : null;
  const sides = receiptSides(kind, c)!;
  const payer = namesOf(partiesOf(c.deal, sides.payer));
  // 売主の当事者が出す手付金・残金は新しいひな形(2026-11-05 発注者)。精算金と自社発行は下の今の書式のまま。
  if (kind !== "settlement_receipt" && issuer.kind === "party") return buildPartyReceipt(kind, c, o, { amount, payer, stamp, exempt, party: issuer.party });
  // 内訳は項目の名前だけ。固都税の土地・建物の行は1つの名前にまとめる(細かい内訳は精算書・2026-11-12)。
  const breakdown = kind === "settlement_receipt"
    ? [...new Set(c.calc.settlement.rows.map((r) => (r.key === "propertyTaxLand" || r.key === "propertyTaxBuilding" ? "固定資産税・都市計画税" : r.label)))].join("・")
    : null;
  const issuerLabel = issuer.kind === "self" ? c.company.nameJa : issuer.party.name;
  // 0円は「非課税」(個人の事業用でない売買を選んだとき)か「不要」(5万円未満など)。
  const stampNone = exempt ? "非課税" : "印紙 不要";

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
