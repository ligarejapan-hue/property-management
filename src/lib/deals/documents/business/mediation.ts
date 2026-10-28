import { yen } from "../../calc/format";
import { html, raw, type SafeHtml } from "../html";
import { documentHtml } from "../layout";
import { MEDIATION_FORM, MEDIATION_KIND_LABELS, type MediationKind } from "../forms/mediation";
import { emptyFormValues } from "../forms/values";
import type { FormValues } from "../forms/types";
import { MEDIATION_GENERAL } from "../texts/mediation-general";
import { MEDIATION_EXCLUSIVE } from "../texts/mediation-exclusive";
import { MEDIATION_DEDICATED } from "../texts/mediation-dedicated";
import type { MediationText } from "../texts/mediation-types";
import { DASH, partiesOf, type BusinessDocContext, type Choice, type ValueRow } from "./common";

const TEXTS: Record<MediationKind, MediationText> = { general: MEDIATION_GENERAL, exclusive: MEDIATION_EXCLUSIVE, dedicated: MEDIATION_DEDICATED };
const REQUEST_LABELS = { sale: "売却", purchase: "購入", exchange: "交換" } as const;
const BLANK = html`<span class="blank"></span>`;
/** 書式の書き込み欄(「年＿月＿日」の月・日など)の短い下線。 */
const SHORT = html`<span class="blank short"></span>`;
const CSS = `.blank{display:inline-block;min-width:24mm;border-bottom:1px solid #333;height:1em;vertical-align:bottom}
.blank.short{min-width:8mm}
.circle{border:1px solid #111;border-radius:50%;padding:0 .2em}
.contract p{margin:1mm 0}
.contract .item{padding-left:1em;text-indent:-1em}
.clauses{font-size:8.5pt;line-height:1.45;column-count:2;column-gap:6mm}
.clauses p{margin:0 0 1mm;text-indent:-1em;padding-left:1em}
.clauses .heading{text-indent:0;padding-left:0;font-weight:bold;margin-top:2mm}
.page{page-break-before:always}`;

const str = (v: FormValues[string] | undefined) => (typeof v === "string" && v.trim() ? v.trim() : null);
const val = (v: string | null): SafeHtml => (v ? html`${v}` : BLANK);
const kindOf = (o: FormValues): MediationKind => (o.kind === "general" || o.kind === "dedicated" ? o.kind : "exclusive");
/** 依頼者の役割: 売却・交換=売主・購入=買主。 */
const clientRole = (requestKind: unknown) => (requestKind === "purchase" ? "buyer" : "seller");

export function mediationDefaults(c: BusinessDocContext): FormValues {
  const b = c.calc.brokerage;
  return {
    ...emptyFormValues(MEDIATION_FORM),
    kind: "exclusive",
    requestKind: c.deal.tradeSide === "buyer" ? "purchase" : "sale",
    months: "3",
    reportMethod: "document",
    reportFrequencyExclusive: "２週間に１",
    reportFrequencyDedicated: "１週間に１",
    registerDaysExclusive: "7",
    registerDaysDedicated: "5",
    feeExcl: b ? yen(b.excl) : null,
    feeTax: b ? yen(b.incl - b.excl) : null,
  };
}

/** 当事者のいない役割(依頼者の候補)。小窓が「依頼の内容」に合わせて「依頼者」の空欄の知らせを作り直す。 */
export function mediationClientMissing(c: BusinessDocContext): Choice[] {
  return (["seller", "buyer"] as const).filter((r) => !partiesOf(c.deal, r).length).map((r) => ({ value: r, label: "依頼者" }));
}

/** 出す前の確認: 依頼者(依頼の内容で売主か買主)・物件の所在地・売買価格。values = 前回の入力を含む初めの値。 */
export function mediationMissing(c: BusinessDocContext, values?: Record<string, unknown>): string[] {
  const role = clientRole(values ? values.requestKind : c.deal.tradeSide === "buyer" ? "purchase" : "sale");
  const out: string[] = [];
  if (!partiesOf(c.deal, role).length) out.push("依頼者");
  if (!c.deal.propertySnapshot.address) out.push("物件の所在地");
  if (c.deal.price === null) out.push("売買価格");
  return out;
}

/** 書式の書き込み欄「＿」を短い下線にする(手で書けるように・最終レビュー)。 */
const withBlanks = (text: string): SafeHtml => html`${text.split("＿").map((t, i) => (i === 0 ? html`${t}` : html`${SHORT}${t}`))}`;

/**
 * 段落の中の目印のすぐ後ろに値を差し込む(計画 段D の決めたこと 1)。
 * slot.after = 目印(空文字なら段落の頭)・slot.drop = 目印の後ろから外す書き込み欄(「＿」など・無ければそのまま)。
 * 目印が無いときは差し込まない。残った「＿」は短い下線にする。
 */
export function fillSlots(text: string, slots: { after: string; drop?: string; value: SafeHtml }[]): SafeHtml {
  const parts: (string | SafeHtml)[] = [];
  let rest = text;
  for (const s of slots) {
    const i = s.after === "" ? 0 : rest.indexOf(s.after);
    if (i < 0) continue;
    const end = i + s.after.length;
    parts.push(rest.slice(0, end), s.value);
    rest = rest.slice(end);
    if (s.drop && rest.startsWith(s.drop)) rest = rest.slice(s.drop.length);
  }
  parts.push(rest);
  return html`${parts.map((p) => (typeof p === "string" ? withBlanks(p) : p))}`;
}

/** 「売却・購入・交換」「（有・無）」などの選んだほうを丸で囲む(文字は変えない)。 */
function circled(text: string, words: string[], chosen: string | null): SafeHtml {
  const re = new RegExp(`(${words.join("|")})`, "g");
  return html`${text.split(re).map((p) => (p === chosen ? html`<span class="circle">${p}</span>` : html`${p}`))}`;
}

/** 最後の「（」から後ろ(「（有・無）」など)だけで丸を付ける(前の「有無」の字は囲まない・最終レビュー)。 */
function circledTail(text: string, words: string[], chosen: string | null): SafeHtml {
  const i = text.lastIndexOf("（");
  return i < 0 ? circled(text, words, chosen) : html`${text.slice(0, i)}${circled(text.slice(i), words, chosen)}`;
}

const isItem = (p: string) => /^([一二三四五六七八九十]+|[イロハニホヘト]|注[０-９0-9]*|＊)　/.test(p);

function contractParagraph(kind: MediationKind, p: string, o: FormValues, last: boolean): SafeHtml | null {
  const yn = (k: string) => (o[k] === "yes" ? "有" : o[k] === "no" ? "無" : null);
  const freq = kind === "dedicated" ? o.reportFrequencyDedicated : o.reportFrequencyExclusive;
  const days = kind === "dedicated" ? o.registerDaysDedicated : o.registerDaysExclusive;
  if (p === "売却・購入・交換") return circled(p, ["売却", "購入", "交換"], typeof o.requestKind === "string" ? REQUEST_LABELS[o.requestKind as keyof typeof REQUEST_LABELS] ?? null : null);
  if (p.includes("建物状況調査を実施する者のあっせんの有無")) return circledTail(p, ["有", "無"], yn("inspection"));
  if (p === "＊") return html`＊　${val(str(o.inspectionReason))}`;
  if (p.includes("指定流通機構への登録の有無")) return html`${circledTail(p.replace(/＊$/, ""), ["有", "無"], yn("listing"))}${p.endsWith("＊") ? "＊" : ""} ${val(str(o.listingName))}`;
  if (p.includes("（注１）")) {
    return fillSlots(p, [
      { after: "（注１）", drop: "＿", value: val(o.reportMethod === "email" ? "電子メール" : o.reportMethod === "document" ? "文書" : null) },
      { after: "（注２）", drop: "＿", value: val(str(freq)) },
    ]);
  }
  if (p.includes("（注３）")) {
    return fillSlots(p, [
      { after: "（注３）", drop: "＿", value: val(str(o.registryName)) },
      { after: "（注４）", drop: "＿", value: val(str(days)) },
    ]);
  }
  if (p.includes("その他（")) return fillSlots(p, [{ after: "その他（", drop: "＿", value: val(str(o.otherDuty)) }]);
  if (p.includes("この媒介契約締結後")) {
    return fillSlots(p, [
      { after: "この媒介契約締結後", drop: "＿", value: val(str(o.months)) },
      // 満了日を入れたときだけ書式の「年月日」を外す(空なら下線の後ろに「年月日」を残して手で書けるように)
      { after: "ヶ月（", drop: str(o.expiry) ? "＿年＿月＿日" : "＿", value: val(str(o.expiry)) },
    ]);
  }
  if (p.includes("（消費税及び地方消費税抜き報酬額）")) {
    return fillSlots(p, [
      { after: "（消費税及び地方消費税抜き報酬額）", drop: "＿", value: val(str(o.feeExcl)) },
      { after: "（消費税額及び地方消費税額の合計額）", drop: "＿", value: val(str(o.feeTax)) },
    ]);
  }
  if (p === "とします。") return fillSlots(p, [{ after: "", value: val(str(o.feeTiming)) }]);
  if (p === "（商号又は名称）（主たる事務所の所在地）") {
    const rows = (str(o.otherAgents) ?? "").split("\n").map((l) => l.split("/").map((x) => x.trim())).filter((r) => r[0]);
    return html`<table><tr><th>（商号又は名称）</th><th>（主たる事務所の所在地）</th></tr>
${rows.length ? rows.map((r) => html`<tr><td>${r[0]}</td><td>${r[1] ?? ""}</td></tr>`) : html`<tr><td style="height:8mm"></td><td></td></tr>`}</table>`;
  }
  if (last && /特約事項$/.test(p)) return html`${p}<div class="remarks" style="min-height:14mm;border:1px solid #999;padding:1.5mm 2mm">${str(o.specialTerms) ?? ""}</div>`;
  return null;
}

/** 依頼者・宅建業者の欄(書式の7行の代わり・署名押印は空欄)。 */
function partiesBlock(c: BusinessDocContext, o: FormValues): SafeHtml {
  const clients = partiesOf(c.deal, clientRole(o.requestKind));
  const rep = [c.settings.representativeTitle, c.settings.representativeName].filter(Boolean).join(" ") || null;
  return html`<div class="right">${val(str(o.contractDateText))}</div>
<table>
<tr><th style="width:24%">甲・依頼者</th><td>${clients.length ? clients.map((p) => html`<div>住所 ${p.address ?? ""}<br>氏名 ${p.name}</div>`) : html`<div>住所<br>氏名</div>`}</td><td style="width:16mm;text-align:center">㊞</td></tr>
<tr><th>乙・宅地建物取引業者</th><td>商号（名称） ${c.company.nameJa}<br>代表者 ${rep ?? ""}<br>主たる事務所の所在地 ${c.company.address ?? ""}<br>免許証番号 ${c.company.license ?? ""}</td><td style="text-align:center">㊞</td></tr>
</table>`;
}

const area = (n: number | null) => (n === null ? "" : `${n}`);
const yenOrBlank = (n: number | null) => (n === null ? "" : `${yen(n)}円`);

/** 別表(計画 段D の決めたこと 5)。 */
function propertyTable(c: BusinessDocContext): SafeHtml {
  const d = c.deal;
  const s = d.propertySnapshot;
  const unit = c.settings.propertyKinds.find((k) => k.key === d.propertyKind)?.base === "unit";
  // 建物の消費税は取引の計算(上書きを含む)から(deal.buildingTax の列は使われていない・最終レビュー)。
  const tax = c.calc.building.tax;
  const body = d.price !== null && tax !== null ? d.price - tax : null;
  return html`<h2>別表</h2>
<table>
<tr><th style="width:18%">所有者</th><td>${partiesOf(d, "seller").map((p) => html`<div>住所 ${p.address ?? ""}　氏名 ${p.name}</div>`)}</td></tr>
<tr><th>登記名義人</th><td>住所　　　氏名</td></tr>
<tr><th>所在地</th><td>${[s.address, s.lotNumber].filter(Boolean).join(" ")}</td></tr>
${unit ? html`<tr><th>マンション</th><td>名称 ${s.buildingName ?? ""}　${s.roomNo ?? ""}号室<br>構造 ${s.structure ?? ""}<br>タイプ ${s.layout ?? ""}　専有面積 ${area(s.floorArea)}㎡<br>共有持分</td></tr>` : html`
<tr><th>土地</th><td>実測　　㎡　公簿 ${area(s.landArea)}㎡<br>地目 宅地・田・畑・山林・雑種地・その他（　　）<br>権利内容 ${circled("所有権・借地権", ["所有権", "借地権"], s.landRight === "ownership" ? "所有権" : s.landRight ? "借地権" : null)}</td></tr>
<tr><th>建物</th><td>建築面積　　㎡　種類<br>構造 ${s.structure ?? ""}　延面積 ${area(s.floorArea)}㎡<br>間取り ${s.layout ?? ""}</td></tr>`}
<tr><th>媒介価額</th><td>本体価額 ${yenOrBlank(body)}<br>消費税額及び地方消費税額の合計額 ${yenOrBlank(tax)}<br>総額 ${yenOrBlank(d.price)}</td></tr>
<tr><th>備考</th><td style="height:10mm"></td></tr>
</table>`;
}

/** 媒介契約書(設計 第2段階 §4.5)。型はタブで選んだもの。契約書の頁と約款は写した文面をそのまま出す。署名・押印は空欄。 */
export function buildMediation(c: BusinessDocContext, o: FormValues): { html: string; rows: ValueRow[] } {
  const kind = kindOf(o);
  const t = TEXTS[kind];
  const at = t.contract.findIndex((p) => p.startsWith("依頼者甲は"));
  const contract = t.contract.map((p, i) => {
    const content = contractParagraph(kind, p, o, i === t.contract.length - 1) ?? withBlanks(p);
    const para = html`<p class="${isItem(p) ? "item" : ""}">${content}</p>`;
    return i === at ? html`${para}${partiesBlock(c, o)}` : para;
  });
  const body = html`<style>${raw(CSS)}</style>
<h1>${t.title}</h1>
<div class="contract">${contract}</div>
${propertyTable(c)}
<div class="page"><h1>${t.clausesTitle}</h1>
<div class="clauses">${t.clauses.map((p) => html`<p class="${/^（.+）$/.test(p) ? "heading" : ""}">${p}</p>`)}</div></div>`;
  const clients = partiesOf(c.deal, clientRole(o.requestKind));
  return {
    html: documentHtml({ title: t.title, font: "mincho", body }),
    rows: [
      { label: "書類", value: t.title },
      { label: "契約の型", value: MEDIATION_KIND_LABELS[kind] },
      { label: "依頼の内容", value: typeof o.requestKind === "string" ? REQUEST_LABELS[o.requestKind as keyof typeof REQUEST_LABELS] ?? null : null },
      { label: "依頼者", value: clients.map((p) => p.name).join("・") || DASH },
      { label: "所在地", value: c.deal.propertySnapshot.address },
      { label: "媒介価額", value: c.deal.price },
      { label: "約定報酬額(税抜き)", value: str(o.feeExcl) },
      { label: "約定報酬額(消費税)", value: str(o.feeTax) },
      { label: "有効期間(月)", value: str(o.months) },
      { label: "満了日", value: str(o.expiry) },
      { label: "特約事項", value: str(o.specialTerms) },
    ],
  };
}
