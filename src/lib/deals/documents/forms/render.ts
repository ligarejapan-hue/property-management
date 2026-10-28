import { html, raw, type SafeHtml } from "../html";
import type { ValueRow } from "../business/common";
import type { FormDef, FormItem, FormValues } from "./types";
import { visibleEntries } from "./values";

const FORM_CSS = `.form-choice{margin-right:4mm;white-space:nowrap}
.form-field{margin-top:1mm}
.form-blank{display:inline-block;min-width:70mm;border-bottom:1px solid #333;height:1.1em;vertical-align:bottom}
.form-text{white-space:pre-wrap}
.form-note{font-size:8.5pt;margin-top:1mm}`;

const picked = (it: FormItem, v: FormValues): string[] => {
  const x = v[it.key];
  return Array.isArray(x) ? x : typeof x === "string" ? [x] : [];
};
const str = (x: FormValues[string] | undefined) => (typeof x === "string" && x ? x : null);

function sections(f: FormDef, v: FormValues): { title: string | null; items: FormItem[] }[] {
  const out: { title: string | null; items: FormItem[] }[] = [];
  for (const e of visibleEntries(f, v)) {
    if (e.kind === "section") out.push({ title: e.title, items: [] });
    else {
      if (!out.length) out.push({ title: null, items: [] });
      out[out.length - 1].items.push(e);
    }
  }
  return out;
}

/** PDF の表。選ばなかった選択肢は □、選んだものは ■、書き込みが空なら下線の空欄(設計 §3.3)。 */
export function renderFormHtml(f: FormDef, v: FormValues): SafeHtml {
  return html`<style>${raw(FORM_CSS)}</style>${sections(f, v).map((s) => html`
${s.title ? html`<h2>${s.title}</h2>` : null}
<table>${s.items.map((it) => {
    const on = picked(it, v);
    return html`<tr><th style="width:30%">${it.label}</th><td>
${it.choices?.length ? html`<div>${it.choices.map((c) => html`<span class="form-choice">${on.includes(c.value) ? "■" : "□"} ${c.label}</span>`)}</div>` : null}
${(it.fields ?? []).map((fl) => {
      const t = str(v[fl.key]);
      return html`<div class="form-field">${fl.label}: ${t ? html`<span class="form-text">${t}</span>` : html`<span class="form-blank"></span>`}</div>`;
    })}
${it.note && on.includes(it.note.when) ? html`<div class="form-note">※ ${it.note.text}</div>` : null}
</td></tr>`;
  })}</table>`)}`;
}

/** Excel(値だけ)の行。区切りは見出し・選んだものはその名前(いくつでもは「・」でつなぐ)・空欄は null。 */
export function formValueRows(f: FormDef, v: FormValues): ValueRow[] {
  return sections(f, v).flatMap((s) => [
    ...(s.title ? [{ label: s.title, heading: true }] : []),
    ...s.items.flatMap((it): ValueRow[] => {
      const on = picked(it, v);
      const labels = (it.choices ?? []).filter((c) => on.includes(c.value)).map((c) => c.label);
      return [
        ...(it.choices?.length ? [{ label: it.label, value: labels.length ? labels.join("・") : null }] : []),
        ...(it.fields ?? []).map((fl) => ({ label: `${it.label} ${fl.label}`, value: str(v[fl.key]) })),
      ];
    }),
  ]);
}
