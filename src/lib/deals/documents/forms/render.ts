import { html, raw, type SafeHtml } from "../html";
import type { ValueRow } from "../business/common";
import type { FormDef, FormField, FormItem, FormValues } from "./types";
import { visibleEntries } from "./values";

const FORM_CSS = `.form-choice{margin-right:4mm;white-space:nowrap}
.form-field{margin-top:1mm}
.form-field-inline{margin-right:2mm;white-space:nowrap}
.form-blank{display:inline-block;min-width:70mm;border-bottom:1px solid #333;height:1.1em;vertical-align:bottom}
.form-blank.short{min-width:12mm}
.form-text{white-space:pre-wrap}
.form-note{font-size:8.5pt;margin-top:1mm}`;

const picked = (it: FormItem, v: FormValues): string[] => {
  const x = v[it.key];
  return Array.isArray(x) ? x : typeof x === "string" ? [x] : [];
};
const str = (x: FormValues[string] | undefined) => (typeof x === "string" && x ? x : null);

/** 選んでいるタブの区切りと項目(PDF・Excel に出さない欄は入れない)。 */
function sections(f: FormDef, v: FormValues): { title: string | null; items: FormItem[] }[] {
  const out: { title: string | null; items: FormItem[] }[] = [];
  for (const e of visibleEntries(f, v)) {
    if (e.kind === "section") out.push({ title: e.title, items: [] });
    else {
      if (e.noPrint) continue;
      if (!out.length) out.push({ title: null, items: [] });
      out[out.length - 1].items.push(e);
    }
  }
  return out;
}

const BLANK = html`<span class="form-blank"></span>`;

/**
 * 書き込み欄。after = 下線の後ろに名前(「＿年」)・pre = 下線の前の書式の字。
 * 名前が空のとき・「：」「／」「）」で終わるときは「:」を付けない(書式に無い字を足さない)。
 * 書き込む行の多い欄(lines)が空なら、行の数だけ下線を出す(手で書けるように)。
 */
function field(fl: FormField, v: FormValues, tight = false): SafeHtml {
  const t = str(v[fl.key]);
  if (fl.after) {
    const value = t ? html`<span class="form-text">${t}</span>` : html`<span class="form-blank short"></span>`;
    // 括弧の中(tight)では欄の間を空けない(「(＿年＿月頃)」)
    return html`<span class="form-field-inline">${fl.pre ?? ""}${value}${fl.label}</span>${tight ? "" : " "}`;
  }
  const lines = !t && fl.lines && fl.lines > 1 ? fl.lines : 1;
  const value = t ? html`<span class="form-text">${t}</span>` : html`${Array.from({ length: lines }, (_, i) => (i ? html`<br>${BLANK}` : BLANK))}`;
  const colon = fl.label && !/[：:／）)]$/.test(fl.label) ? ":" : "";
  return html`<div class="form-field">${fl.pre ?? ""}${fl.label}${colon}${t ? " " : ""}${value}</div>`;
}

/**
 * PDF の表。選ばなかった選択肢は □、選んだものは ■、書き込みが空なら下線の空欄(設計 §3.3)。
 * 下の行(sub)は項目の欄を空け、状況の欄の頭に見出しを出す(告知書・段E)。
 */
export function renderFormHtml(f: FormDef, v: FormValues): SafeHtml {
  return html`<style>${raw(FORM_CSS)}</style>${sections(f, v).map((s) => html`
${s.title ? html`<h2>${s.title}</h2>` : null}
<table>${s.items.map((it) => {
    const on = picked(it, v);
    const inline = (it.fields ?? []).filter((fl) => fl.after);
    const block = (it.fields ?? []).filter((fl) => !fl.after);
    const subLabel = it.sub && it.label ? html`${it.label}` : null;
    // 年月の欄を選択肢のすぐ後ろの括弧の中に出す(告知書 ⑤)・選択肢を書式の括弧で囲む(告知書 ⑧)(2026-10-30)
    const at = it.fieldsAt && inline.length ? it.fieldsAt : null;
    const choices = it.choices?.map((c) => html`<span class="form-choice">${on.includes(c.value) ? "■" : "□"} ${c.label}${at?.choice === c.value
      ? html`${at.open}${inline.map((fl) => field(fl, v, true))}${at.close}` : null}</span>`);
    const wrapped = it.around ? html`${it.around[0]}${choices}${it.around[1]}` : html`${choices}`;
    const rest = at ? [] : inline;
    return html`<tr><th style="width:30%">${it.sub ? "" : it.label}</th><td>
${it.choices?.length
    ? it.fieldsFirst
      ? html`<div>${rest.map((fl) => field(fl, v))}${subLabel}${wrapped}</div>`
      : html`<div>${subLabel}${wrapped}${rest.map((fl) => field(fl, v))}</div>`
    : inline.length ? html`<div>${subLabel}${inline.map((fl) => field(fl, v))}</div>` : subLabel && !block.length ? html`<div>${subLabel}</div>` : null}
${block.map((fl) => field(fl, v))}
${it.note && on.includes(it.note.when) ? html`<div class="form-note">※ ${it.note.text}</div>` : null}
</td></tr>`;
  })}</table>`)}`;
}

/**
 * Excel(値だけ)の行。区切りは見出し・選んだものはその名前(いくつでもは「・」でつなぐ)・空欄は null。
 * 下の行は、上の番号の行の見出しを頭に付ける。選択肢も書き込み欄も無い番号の行は出さない。
 */
export function formValueRows(f: FormDef, v: FormValues): ValueRow[] {
  return sections(f, v).flatMap((s) => {
    let head = "";
    return [
      ...(s.title ? [{ label: s.title, heading: true }] : []),
      ...s.items.flatMap((it): ValueRow[] => {
        // 同じ字の見出しが2つある書式は name で見分ける(区分の告知書の「備考：」・2026-10-30)
        if (!it.sub) head = it.name ?? it.label;
        const own = it.name ?? (it.label || (it.choices ?? []).map((c) => c.label).join("・"));
        const label = it.sub ? `${head} ${own}`.trim() : it.name ?? it.label;
        const on = picked(it, v);
        const labels = (it.choices ?? []).filter((c) => on.includes(c.value)).map((c) => c.label);
        return [
          ...(it.choices?.length ? [{ label, value: labels.length ? labels.join("・") : null }] : []),
          ...(it.fields ?? []).map((fl) => ({ label: `${label} ${fl.label}`.trim(), value: str(v[fl.key]) })),
        ];
      }),
    ];
  });
}
