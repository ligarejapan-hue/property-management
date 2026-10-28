import { z } from "zod";
import { CHECKLIST_GROUPS, type ChecklistGroup, type ChecklistItem, type ChecklistPhase } from "../../checklist";
import { html } from "../html";
import { documentHtml } from "../layout";
import { checklistItemsOf } from "./checklist-doc";
import { ymdJa } from "./contract-guide";
import { DASH, dateJa, headTable, namesOf, partiesOf, propertyLabel, type BusinessDocContext, type Choice, type ValueRow } from "./common";

/** 準備チェックリストの種類(設計 第2段階 §2 の 4・5)。 */
export const PREP_KINDS = { land: "土地建物用", unit: "マンション用" } as const;
export type PrepKind = keyof typeof PREP_KINDS;
export const prepChecklistOptionsSchema = z.object({ kind: z.enum(["land", "unit"]) }).strict();
export type PrepChecklistOptions = z.output<typeof prepChecklistOptionsSchema>;

/** 種類の初期値: 元の種別が区分ならマンション用、戸建・土地・一棟なら土地建物用。決まらなければ null(発行のときに選ぶ)。 */
export function defaultPrepKind(c: BusinessDocContext): PrepKind | null {
  const base = c.settings.propertyKinds.find((k) => k.key === c.deal.propertyKind)?.base ?? null;
  return base === "unit" ? "unit" : base ? "land" : null;
}

export const prepKindChoices = (): Choice[] => (Object.keys(PREP_KINDS) as PrepKind[]).map((k) => ({ value: k, label: PREP_KINDS[k] }));

export function prepChecklistMissing(c: BusinessDocContext): string[] {
  const out: string[] = [];
  if (!defaultPrepKind(c)) out.push("物件の種別");
  if (!c.deal.contractAt) out.push("契約日");
  if (!c.deal.settlementAt) out.push("決済日");
  return out;
}

/** 並び(設計 §4.4): 契約前 → 契約日 → 決済前 → 決済日。 */
const STAGES: { title: string; phase: ChecklistPhase; groups: ChecklistGroup[] }[] = [
  { title: "契約前", phase: "contract", groups: ["prepare"] },
  { title: "契約日", phase: "contract", groups: ["bring", "receive"] },
  { title: "決済前", phase: "settlement", groups: ["prepare"] },
  { title: "決済日", phase: "settlement", groups: ["bring", "receive"] },
];

/** 時点ごとの項目。種類で項目を絞る(土地建物用=土地のある物件・マンション用=区分)。謄本の抹消の自動の行も同じ決まりで入る。 */
export function prepStagesOf(
  c: BusinessDocContext, kind: PrepKind,
): { title: string; phase: ChecklistPhase; groups: { group: ChecklistGroup; items: ChecklistItem[] }[] }[] {
  const base = kind === "unit" ? "unit" : "house";
  return STAGES.map((s) => {
    const items = checklistItemsOf(s.phase, c, { use: "prep", base });
    return { title: s.title, phase: s.phase, groups: s.groups.map((g) => ({ group: g, items: items.filter((i) => i.group === g) })) };
  });
}

/** 準備チェックリスト(設計 第2段階 §4.4)。済・担当の欄は空欄(紙に手で書く)。 */
export function buildPrepChecklist(c: BusinessDocContext, o: PrepChecklistOptions): { html: string; rows: ValueRow[] } {
  const d = c.deal;
  const title = `準備チェックリスト(${PREP_KINDS[o.kind]})`;
  const due: Record<ChecklistPhase, string | null> = { contract: ymdJa(d.contractAt), settlement: ymdJa(d.settlementAt) };
  const head: [string, string | null][] = [
    ["取引番号", d.dealNo], ["物件", propertyLabel(d)],
    ["売主", namesOf(partiesOf(d, "seller"))], ["買主", namesOf(partiesOf(d, "buyer"))],
    ["契約日", due.contract], ["決済日", due.settlement],
    ["営業担当", c.staff?.sales ?? null], ["業務担当", c.staff?.ops ?? null],
  ];
  const stages = prepStagesOf(c, o.kind);
  const body = html`
<h1>${title}</h1>
<div class="right">${dateJa(c.today)}</div>
${headTable(head)}
${stages.map((s) => (s.groups.some((g) => g.items.length) ? html`<h2>${s.title}</h2>
<table><tr><th>済</th><th>項目</th><th>メモ</th><th>期日</th><th>担当</th></tr>
${s.groups.map((g) => (g.items.length ? html`${s.groups.length > 1 ? html`<tr><th colspan="5">${CHECKLIST_GROUPS[g.group]}</th></tr>` : null}
${g.items.map((i) => html`<tr><td style="text-align:center;width:10mm">□</td><td>${i.label}</td><td style="width:30%">${i.note ?? ""}</td><td style="width:22mm">${due[s.phase] ?? ""}</td><td style="width:18mm"></td></tr>`)}` : null))}
</table>` : null))}`;
  return {
    html: documentHtml({ title, body }),
    rows: [
      { label: "書類", value: title },
      ...head.map(([label, value]) => ({ label, value: value ?? DASH })),
      ...stages.flatMap((s) => [
        { label: s.title, heading: true },
        ...s.groups.flatMap((g) => g.items.map((i): ValueRow => ({ label: i.label, value: [i.note, due[s.phase]].filter(Boolean).join(" / ") || null }))),
      ]),
    ],
  };
}
