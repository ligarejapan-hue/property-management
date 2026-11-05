import { z } from "zod";
import {
  CHECKLIST_AMOUNTS, CHECKLIST_GROUPS, CHECKLIST_ITEM_ID, CHECKLIST_PAY_METHODS, CHECKLIST_PAY_OTHER_MAX, CHECKLIST_PHASES, itemsFor,
  type ChecklistAmount, type ChecklistDoc, type ChecklistGroup, type ChecklistItem, type ChecklistPayMethod, type ChecklistPhase,
} from "../../checklist";
import type { BASE_PROPERTY_KINDS } from "../../constants";
import { html } from "../html";
import { documentHtml } from "../layout";
import { DASH, dateJa, dateTimeJa, headTable, money, namesOf, partiesOf, propertyLabel, type BusinessDocContext, type Choice, type ValueRow } from "./common";

const payEntrySchema = z.object({
  method: z.enum(Object.keys(CHECKLIST_PAY_METHODS) as [ChecklistPayMethod, ...ChecklistPayMethod[]]),
  /** 2つ以上の払い方を選んだときの、その払い方の金額(円)。1つだけなら null(金額の欄の額)。 */
  amount: z.number().int().min(0).max(9_999_999_999_999).nullable(),
  /** 「その他」のときだけの手入力。 */
  other: z.string().trim().max(CHECKLIST_PAY_OTHER_MAX, `その他の払い方は${CHECKLIST_PAY_OTHER_MAX}文字までです`).nullable(),
}).strict();
export type ChecklistPayEntry = z.output<typeof payEntrySchema>;

/** 前の形(払い方を1つの文字で送っていた)。現金だけ引き継ぎ、手付金から・残金からは選んでいないことにする。 */
const LEGACY_PAY: Record<string, ChecklistPayEntry[]> = { cash: [{ method: "cash", amount: null, other: null }], from_deposit: [], from_balance: [] };
const legacyPay = (v: unknown) => (typeof v === "string" && v in LEGACY_PAY ? LEGACY_PAY[v] : v);

/**
 * 発行のときに選ぶもの: 持参する金額の払い方(項目の鍵ごと・いくつでも・計画 段5c-1 の読み替え 4)。
 * 同じ払い方は1回だけ。何も選ばなければ払い方の欄は空(紙に手で書く)。
 */
export const checklistOptionsSchema = z.object({
  pay: z.record(z.string().regex(CHECKLIST_ITEM_ID), z.preprocess(legacyPay, z.array(payEntrySchema).max(Object.keys(CHECKLIST_PAY_METHODS).length)
    .refine((es) => new Set(es.map((e) => e.method)).size === es.length, "同じ払い方が重なっています"))),
}).strict();
export type ChecklistOptions = z.output<typeof checklistOptionsSchema>;

/** 払い方の欄の文字。2つ以上なら「振込 300,000円／現金 50,000円」。その他は手入力を括弧で添える。 */
export function payText(entries: ChecklistPayEntry[] | undefined): string {
  const es = entries ?? [];
  return es.map((e) => {
    const name = e.method === "other" && e.other ? `${CHECKLIST_PAY_METHODS.other}(${e.other})` : CHECKLIST_PAY_METHODS[e.method];
    return es.length > 1 && e.amount !== null ? `${name} ${money(e.amount)}` : name;
  }).join("／");
}

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

const auto = (id: string, group: ChecklistItem["group"], label: string, amount: ChecklistAmount | null = null): ChecklistItem =>
  ({ id, phase: "settlement", group, label, note: "謄本の登記の現況から自動で追加", scope: "all", amount });

/**
 * その取引で出す項目(取引の物件種別の元の種別・OC の有無・使う書類で出し分ける)。
 * 決済時は、謄本の乙区に権利が残っていれば抹消の3項目を足す(設計 §4.6.1)。持参の抹消費用は、設定にすでに抹消費用の金額付き項目があれば足さない。
 * opts.use = 取り出す先の書類(初めは書類確認書)・opts.base = 元の種別を置き換える(準備チェックリストの種類)。
 */
export function checklistItemsOf(
  phase: ChecklistPhase, c: BusinessDocContext,
  opts: { use?: ChecklistDoc; base?: (typeof BASE_PROPERTY_KINDS)[number] | null } = {},
): ChecklistItem[] {
  const base = opts.base !== undefined ? opts.base : c.settings.propertyKinds.find((k) => k.key === c.deal.propertyKind)?.base ?? null;
  const items = itemsFor(c.settings.checklistItems, phase, { base, hasOc: c.deal.hasOc }, opts.use ?? "checklist");
  const n = c.registry?.activeRights ?? 0;
  if (phase !== "settlement" || n === 0) return items;
  return [
    ...items,
    auto("auto_cancel_request", "prepare", `司法書士への抹消の依頼(抵当権など ${n}件)`),
    ...(items.some((i) => i.amount === "cancellation") ? [] : [auto("auto_cancel_fee", "bring", "抹消費用", "cancellation")]),
    auto("auto_cancel_docs", "receive", "抵当権抹消書類(金融機関)"),
  ];
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
    values: { pay: Object.fromEntries(items.map((i) => [i.id, [] as ChecklistPayEntry[]])) },
    choices: {
      payItems: items.map((i) => ({ value: i.id, label: `${i.label}(${money(checklistAmount(i.amount, c))})` })),
      // 内訳の合計を画面で確かめるための金額(円・無ければ空)。
      payTotals: items.map((i) => ({ value: i.id, label: String(checklistAmount(i.amount, c) ?? "") })),
    },
  };
}

const joinParts = (...xs: (string | null | undefined)[]) => xs.filter(Boolean).join(" ") || null;
const box = html`<td style="text-align:center;width:12mm">□</td>`;

const checkedBox = html`<td style="text-align:center;width:12mm">✓</td>`;

/** 書類確認書(設計 §4.6)。チェック欄は空欄(紙に手で付ける)。お客様の提出で受領した項目だけ ✓ を印字する。最後の行は承認欄。 */
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
    ...(c.registry?.caution ? [["登記の注意", c.registry.caution] as [string, string]] : []),
  ];
  const items = checklistItemsOf(phase, c);
  const of = (g: ChecklistGroup) => items.filter((i) => i.group === g);
  const payOf = (i: ChecklistItem) => payText(o.pay[i.id]);
  const received = (i: ChecklistItem) => phase === "settlement" && (c.receivedItemIds?.has(i.id) ?? false);
  const confirmBox = (i: ChecklistItem) => (received(i) ? checkedBox : box);

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
<table><tr><th>項目</th><th style="width:20%">金額</th><th style="width:26%">払い方</th><th style="width:12mm">確認</th><th style="width:18%">注意事項</th></tr>
${bring.map((i) => html`<tr><td>${i.label}</td><td class="num">${i.amount ? money(checklistAmount(i.amount, c)) : ""}</td><td>${i.amount ? payOf(i) : ""}</td>${confirmBox(i)}<td>${i.note ?? ""}</td></tr>`)}</table>` : null}
${receive.length ? html`<h2>${CHECKLIST_GROUPS.receive}</h2>
<table><tr><th>項目</th><th style="width:12mm">確認</th><th style="width:28%">注意事項</th><th style="width:24%">メモ</th></tr>
${receive.map((i) => html`<tr><td>${i.label}</td>${confirmBox(i)}<td>${i.note ?? ""}</td><td></td></tr>`)}</table>` : null}
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
          : { label: i.label, value: received(i) ? ["受領済み", i.note].filter(Boolean).join(" ") : i.note })),
        ...list.filter((i) => i.amount).map((i): ValueRow => ({ label: `払い方: ${i.label}`, value: payOf(i) })),
      ];
    }),
  ];
  return { html: documentHtml({ title, body }), rows };
}
