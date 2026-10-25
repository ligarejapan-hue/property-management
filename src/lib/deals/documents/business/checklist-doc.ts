import { z } from "zod";
import {
  CHECKLIST_AMOUNTS, CHECKLIST_GROUPS, CHECKLIST_ITEM_ID, CHECKLIST_PAY_METHODS, CHECKLIST_PHASES, itemsFor,
  type ChecklistAmount, type ChecklistGroup, type ChecklistItem, type ChecklistPayMethod, type ChecklistPhase,
} from "../../checklist";
import { html } from "../html";
import { documentHtml } from "../layout";
import { DASH, dateJa, dateTimeJa, headTable, money, namesOf, partiesOf, propertyLabel, type BusinessDocContext, type Choice, type ValueRow } from "./common";

/** 発行のときに選ぶもの: 持参する金額の払い方(項目の鍵ごと・計画 段5c-1 の読み替え 4)。 */
export const checklistOptionsSchema = z.object({
  pay: z.record(z.string().regex(CHECKLIST_ITEM_ID), z.enum(Object.keys(CHECKLIST_PAY_METHODS) as [ChecklistPayMethod, ...ChecklistPayMethod[]])),
}).strict();
export type ChecklistOptions = z.output<typeof checklistOptionsSchema>;

/** 持参する金額(決済の計算と取引の値をそのまま使う・設計 §4.6)。 */
export function checklistAmount(a: ChecklistAmount, c: BusinessDocContext): number | null {
  const d = c.deal;
  switch (a) {
    case "deposit": return d.deposit;
    case "payment": return c.calc.settlement.paymentAtSettlement;
    case "registration": return d.costs.registrationFee;
    case "cancellation": return d.costs.cancellationFee;
    case "survey": return d.costs.surveyFee;
  }
}

/** その取引で出す項目(取引の物件種別の元の種別・OC の有無で出し分ける)。 */
export function checklistItemsOf(phase: ChecklistPhase, c: BusinessDocContext): ChecklistItem[] {
  const base = c.settings.propertyKinds.find((k) => k.key === c.deal.propertyKind)?.base ?? null;
  return itemsFor(c.settings.checklistItems, phase, { base, hasOc: c.deal.hasOc });
}

const amountItems = (phase: ChecklistPhase, c: BusinessDocContext) =>
  checklistItemsOf(phase, c).filter((i): i is ChecklistItem & { amount: ChecklistAmount } => i.amount !== null);

/** 出す前の確認: 日時・売主・買主と、金額の無い持参の項目。 */
export function checklistMissing(phase: ChecklistPhase, c: BusinessDocContext): string[] {
  const d = c.deal;
  const out: string[] = [];
  if (!(phase === "contract" ? d.contractAt : d.settlementAt)) out.push(`${CHECKLIST_PHASES[phase].replace("時", "")}日時`);
  if (!partiesOf(d, "seller").length) out.push("売主");
  if (!partiesOf(d, "buyer").length) out.push("買主");
  for (const i of amountItems(phase, c)) {
    const name = CHECKLIST_AMOUNTS[i.amount].replace(/\(.*\)$/, "");
    if (checklistAmount(i.amount, c) === null && !out.includes(name)) out.push(name);
  }
  return out;
}

export function checklistDefaults(phase: ChecklistPhase, c: BusinessDocContext): { values: ChecklistOptions; choices: Record<string, Choice[]> } {
  const items = amountItems(phase, c);
  return {
    values: { pay: Object.fromEntries(items.map((i) => [i.id, "cash" as const])) },
    choices: {
      payItems: items.map((i) => ({ value: i.id, label: `${i.label}(${money(checklistAmount(i.amount, c))})` })),
      payMethods: Object.entries(CHECKLIST_PAY_METHODS).map(([value, label]) => ({ value, label })),
    },
  };
}

const joinParts = (...xs: (string | null | undefined)[]) => xs.filter(Boolean).join(" ") || null;
const box = html`<td style="text-align:center;width:12mm">□</td>`;

/** 書類確認書(設計 §4.6)。チェック欄は空欄(紙に手で付ける)。最後の行は承認欄。 */
export function buildChecklistDoc(phase: ChecklistPhase, c: BusinessDocContext, o: ChecklistOptions): { html: string; rows: ValueRow[] } {
  const d = c.deal;
  const title = `書類確認書(${CHECKLIST_PHASES[phase]})`;
  const at = phase === "contract" ? d.contractAt : d.settlementAt;
  const place = phase === "contract" ? d.contractPlace : d.settlementPlace;
  const broker = joinParts(d.counterpartyBroker.company, d.counterpartyBroker.staff, d.counterpartyBroker.tel && `TEL ${d.counterpartyBroker.tel}`);
  const sc = d.costs.scrivener;
  const scrivener = joinParts(sc.name, sc.staff && `担当 ${sc.staff}`, sc.tel && `TEL ${sc.tel}`);
  const head: [string, string | null][] = [
    ["取引番号", d.dealNo], ["物件", propertyLabel(d)],
    ["売主", namesOf(partiesOf(d, "seller"))], ["買主", namesOf(partiesOf(d, "buyer"))],
    ["日時", at ? dateTimeJa(at) : null], ["場所", place],
    ["相手方の仲介", broker], ["司法書士", scrivener],
    ["営業担当", c.staff?.sales ?? null], ["業務担当", c.staff?.ops ?? null],
  ];
  const items = checklistItemsOf(phase, c);
  const of = (g: ChecklistGroup) => items.filter((i) => i.group === g);
  const payOf = (i: ChecklistItem) => CHECKLIST_PAY_METHODS[o.pay[i.id] ?? "cash"];

  const prepare = of("prepare");
  const bring = of("bring");
  const receive = of("receive");
  const body = html`
<h1>${title}</h1>
<div class="right">${dateJa(c.today)}</div>
${headTable(head)}
${prepare.length ? html`<h2>${CHECKLIST_GROUPS.prepare}</h2>
<table><tr><th>項目</th><th style="width:12mm">営業</th><th style="width:12mm">業務</th><th style="width:34%">注意事項</th></tr>
${prepare.map((i) => html`<tr><td>${i.label}</td>${box}${box}<td>${i.note ?? ""}</td></tr>`)}</table>` : null}
${bring.length ? html`<h2>${CHECKLIST_GROUPS.bring}</h2>
<table><tr><th>項目</th><th style="width:24%">金額</th><th style="width:14%">払い方</th><th style="width:12mm">確認</th><th style="width:26%">注意事項</th></tr>
${bring.map((i) => html`<tr><td>${i.label}</td><td class="num">${i.amount ? money(checklistAmount(i.amount, c)) : ""}</td><td>${i.amount ? payOf(i) : ""}</td>${box}<td>${i.note ?? ""}</td></tr>`)}</table>` : null}
${receive.length ? html`<h2>${CHECKLIST_GROUPS.receive}</h2>
<table><tr><th>項目</th><th style="width:12mm">確認</th><th style="width:28%">注意事項</th><th style="width:24%">メモ</th></tr>
${receive.map((i) => html`<tr><td>${i.label}</td>${box}<td>${i.note ?? ""}</td><td></td></tr>`)}</table>` : null}
<table style="margin-top:6mm"><tr><th style="width:33%">営業担当</th><th style="width:33%">業務担当</th><th>承認</th></tr>
<tr><td style="height:16mm"></td><td></td><td></td></tr></table>`;

  const rows: ValueRow[] = [
    { label: "書類", value: title },
    ...head.map(([label, value]) => ({ label, value: value ?? DASH })),
    ...(Object.keys(CHECKLIST_GROUPS) as ChecklistGroup[]).flatMap((g) => {
      const list = of(g);
      if (!list.length) return [];
      return [
        { label: CHECKLIST_GROUPS[g], heading: true },
        ...list.map((i): ValueRow => (i.amount
          ? { label: `持参: ${i.label}`, value: checklistAmount(i.amount, c) }
          : { label: i.label, value: i.note })),
        ...list.filter((i) => i.amount).map((i): ValueRow => ({ label: `払い方: ${i.label}`, value: payOf(i) })),
      ];
    }),
  ];
  return { html: documentHtml({ title, body }), rows };
}
