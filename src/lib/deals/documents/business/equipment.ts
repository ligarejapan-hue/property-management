import { html, raw, type SafeHtml } from "../html";
import { documentHtml } from "../layout";
import { EQUIP_FAULT, EQUIP_SAFETY, EQUIPMENT_FORM, EQUIPMENT_KIND_LABELS, EQUIPMENT_ROWS, equipLabel, type EquipmentKind, type EquipRow } from "../forms/equipment";
import { emptyFormValues } from "../forms/values";
import { formValueRows } from "../forms/render";
import type { FormValues } from "../forms/types";
import { EQUIPMENT_HOUSE_SOURCE } from "../texts/equipment-house";
import { EQUIPMENT_UNIT_SOURCE } from "../texts/equipment-unit";
import type { DisclosureSource } from "../texts/disclosure-types";
import type { BusinessDocContext, ValueRow } from "./common";

const SOURCES: Record<EquipmentKind, DisclosureSource> = { house: EQUIPMENT_HOUSE_SOURCE, unit: EQUIPMENT_UNIT_SOURCE };
const CSS = `.equip th,.equip td{font-size:8.5pt;padding:.8mm 1.5mm}
.equip .group{background:#f3f4f6;text-align:left}
.equip .subgroup{background:#fafafa;text-align:left;font-weight:normal;padding-left:4mm}
.equip .yn{width:16mm;text-align:center;white-space:nowrap}
.circle{border:1px solid #111;border-radius:50%;padding:0 .2em}
.blank{display:inline-block;min-width:18mm;border-bottom:1px solid #333;height:1em;vertical-align:bottom}
.blank.long{min-width:40mm}
.notes p,.guide p{white-space:pre-wrap;margin:1.5mm 0}
.sign td{height:12mm;vertical-align:bottom}
.page{page-break-before:always}`;

const kindOf = (o: FormValues): EquipmentKind => (o.kind === "unit" ? "unit" : "house");
const str = (x: FormValues[string] | undefined) => (typeof x === "string" && x.trim() ? x : null);
const list = (x: FormValues[string] | undefined) => (Array.isArray(x) ? x : typeof x === "string" ? [x] : []);
const val = (x: string | null, long = false): SafeHtml => (x ? html`${x}` : html`<span class="blank${long ? " long" : ""}"></span>`);

/**
 * 最初の「（」から後ろだけで、選んだ言葉を丸で囲む(同じ字がほかにあっても囲まない・段F の決めたこと 3)。
 * 最初の「（」で切る(「（食器棚（造付）・…）」のように括弧が二重でも、言葉ごと囲めるように・最終レビュー)。
 */
function circledTail(text: string, words: readonly string[], chosen: readonly string[], whole = false): SafeHtml {
  const i = whole ? -1 : text.indexOf("（");
  const head = i < 0 ? "" : text.slice(0, i);
  const tail = i < 0 ? text : text.slice(i);
  const sorted = [...words].sort((a, b) => b.length - a.length).map((w) => w.replace(/[()（）]/g, "\\$&"));
  const parts = sorted.length ? tail.split(new RegExp(`(${sorted.join("|")})`, "g")) : [tail];
  return html`${head}${parts.map((p) => (chosen.includes(p) && words.includes(p) ? html`<span class="circle">${p}</span>` : html`${p}`))}`;
}

const yn = (x: FormValues[string] | undefined) => circledTail("有・無", ["有", "無"], list(x));

function rowHtml(r: EquipRow, kind: EquipmentKind, o: FormValues, nameHeader: string): SafeHtml {
  const p = kind === "house" ? "h" : "u";
  if (r.kind === "group") return html`<tr><th colspan="4" class="${r.sub ? "subgroup" : "group"}">${r.title}</th></tr>`;
  if (r.kind === "note") return html`<tr><th>備考</th><td colspan="3" style="height:14mm;white-space:pre-wrap">${str(o[`${p}${r.key}Text`]) ?? ""}</td></tr>`;
  if (r.kind === "blank") {
    return html`<tr><td>${val(str(o[`${p}${r.key}Name`]))}</td><td></td><td class="yn">${yn(o[p + r.key])}</td><td>${str(o[`${p}${r.key}Fault`]) ?? ""}</td></tr>`;
  }
  if (r.kind !== "equip") return html``;
  // 書式で2つのセル(2行)に分かれている内容は、2行のまま出す(2行目は括弧の中なので、全部を丸の対象にする)。
  const details = (r.details ?? []).map((dt, i) => {
    const chosen = list(o[`${p}${r.key}D${i}`]);
    return html`<div>${dt.parts.map((part, j) => html`${j ? html`<br>` : null}${circledTail(part, dt.options ?? [], chosen, j > 0)}`)}</div>`;
  });
  void nameHeader;
  return html`<tr><td>${r.name}</td><td>${details}
${r.place ? html`<div>設置箇所：${val(str(o[`${p}${r.key}Place`]), true)}</div>` : null}
${r.count ? html`<div>計${val(str(o[`${p}${r.key}Count`]))}${r.count}</div>` : null}
${r.safety ? html`<div>${EQUIP_SAFETY}　${yn(o[`${p}${r.key}S`])}</div>` : null}</td>
<td class="yn">${yn(o[p + r.key])}</td><td>${str(o[`${p}${r.key}Fault`]) ?? ""}</td></tr>`;
}

function tablesHtml(kind: EquipmentKind, o: FormValues): SafeHtml {
  const groups: { head: Extract<EquipRow, { kind: "table" }>; rows: EquipRow[] }[] = [];
  for (const r of EQUIPMENT_ROWS[kind]) {
    if (r.kind === "table") groups.push({ head: r, rows: [] });
    else groups[groups.length - 1].rows.push(r);
  }
  return html`${groups.map((g) => html`<h2>${g.head.title}</h2>
<table class="equip"><tr><th>${g.head.nameHeader}</th><th>${g.head.detailHeader}</th><th>設備の有無</th><th>${EQUIP_FAULT}</th></tr>
${g.rows.map((r) => rowHtml(r, kind, o, g.head.nameHeader))}</table>`)}`;
}

function propertyName(c: BusinessDocContext): string | null {
  const s = c.deal.propertySnapshot;
  return [s.buildingName, s.roomNo && `${s.roomNo}号室`].filter(Boolean).join(" ") || s.address || null;
}

const baseOf = (c: BusinessDocContext) => c.settings.propertyKinds.find((k) => k.key === c.deal.propertyKind)?.base ?? null;

/** 土地だけの物件には出さない(設計 §4.8)。種別が決まらない取引では出す。 */
export const equipmentApplies = (c: BusinessDocContext) => baseOf(c) !== "land";

export function equipmentDefaults(c: BusinessDocContext): FormValues {
  return { ...emptyFormValues(EQUIPMENT_FORM), kind: baseOf(c) === "unit" ? "unit" : "house", withGuide: "付ける" };
}

export function equipmentMissing(c: BusinessDocContext): string[] {
  return propertyName(c) ? [] : ["物件名"];
}

/** 付帯設備表(設計 第2段階 §4.8)。頭の説明文・注２・署名の文は取り出したセルの文字をそのまま使う(段F の決めたこと 5)。 */
export function buildEquipment(c: BusinessDocContext, o: FormValues): { html: string; rows: ValueRow[] } {
  const kind = kindOf(o);
  const src = SOURCES[kind];
  const title = `付帯設備表（${EQUIPMENT_KIND_LABELS[kind]}）`;
  const cell = (prefix: string) => src.formCells.find((x) => x.startsWith(prefix)) ?? "";
  const name = propertyName(c);
  const guide = o.withGuide !== "付けない" ? html`
<div class="page guide"><h1 style="font-size:13pt;letter-spacing:0">${src.coverTitle}</h1>${src.cover.map((p) => html`<p>${p}</p>`)}</div>
<div class="page guide"><h1 style="font-size:13pt;letter-spacing:0">${src.guideTitle}</h1>
${src.guide.map((b) => (b.kind === "note" ? html`<p>${b.text}</p>` : html`<table><tr><th style="width:30%">${b.item}</th><td style="white-space:pre-wrap">${b.text}</td></tr></table>`))}</div>` : null;
  const body = html`<style>${raw(CSS)}</style>
<h1 style="font-size:14pt;letter-spacing:0">${title}</h1>
<div class="right">（物件名：${name ?? ""}）</div>
<div class="notes"><p>${cell("「設備の有無」欄に")}</p></div>
${tablesHtml(kind, o)}
<div class="notes"><p style="font-size:8pt">${cell("※注２")}</p></div>
<p class="right" style="margin-top:4mm">年　　　月　　　日</p>
<p>${cell("本物件の付帯設備が上記のとおりであることを")}</p>
<table class="sign"><tr><th style="width:18%">＜売主＞</th><td>氏名</td><td style="width:14mm;text-align:center">印</td></tr></table>
<p>${cell("上記のとおり、売主より告知を受けました")}</p>
<table class="sign"><tr><th style="width:18%">＜買主＞</th><td>氏名</td><td style="width:14mm;text-align:center">印</td></tr></table>
${guide}`;
  return {
    html: documentHtml({ title, font: "mincho", body }),
    rows: [{ label: "書類", value: title }, { label: "物件名", value: name }, ...formValueRows(EQUIPMENT_FORM, o)],
  };
}

export { equipLabel };
