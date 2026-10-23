/**
 * 書類の HTML を組み立てる小さな道具。差し込む値は必ずエスケープし、素通しするのは
 * `html` で作ったものと `raw()` で明示したものだけ(このクラスの実体かどうかで見分ける=JSON から来た偽物は通さない)。
 * route で react-dom/server を使わない(react-server のバンドルと衝突する)ための作り。
 */
export class SafeHtml {
  constructor(readonly __html: string) {}
  toString(): string {
    return this.__html;
  }
}

export type HtmlValue = SafeHtml | string | number | null | undefined | false | readonly HtmlValue[];

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function part(v: HtmlValue): string {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof SafeHtml) return v.__html;
  if (Array.isArray(v)) return v.map(part).join("");
  return esc(String(v));
}

export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += part(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/** 自分で書いた固定の HTML(CSS など)だけに使う。外から来た文字には使わない。 */
export const raw = (s: string): SafeHtml => new SafeHtml(s);
