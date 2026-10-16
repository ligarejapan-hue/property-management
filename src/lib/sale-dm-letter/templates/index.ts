import type { LetterRenderInput } from "./types";
import { isSafeIllustrationSrc } from "../letter-illustration";
import { parseLetterBody, LETTER_FIXED_TEXT, type LetterBlock } from "../letter-layout";
import { LP_BRAND } from "../lp-brand";

export const DESIGN_TEMPLATES = ["formal", "soft", "impact"] as const;
export type DesignTemplate = (typeof DESIGN_TEMPLATES)[number];

export function resolveDesignTemplate(value: string): DesignTemplate {
  return (DESIGN_TEMPLATES as readonly string[]).includes(value)
    ? (value as DesignTemplate)
    : "formal";
}

// HTML 特殊文字を実体参照へ。順序重要(& を最初に)。null/undefined は空文字。
export function escapeHtml(value: string | null | undefined): string {
  if (value == null) return "";
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 行の並びを「エスケープしてから <br /> でつなぐ」(唯一の生 HTML は <br /> だけ。AI 生成本文を生 HTML として出さない)。
const linesHtml = (lines: string[]) => lines.map((l) => escapeHtml(l)).join("<br />\n");

// 絵の <img>。検査済みの src と整数の寸法だけから組む。縦横比は元のまま(CSS で height:auto)。
function illustrationHtml(illustration: LetterRenderInput["illustration"]): string | null {
  if (!illustration || !isSafeIllustrationSrc(illustration.src)) return null;
  const w = Number.isInteger(illustration.width) && illustration.width > 0 ? ` width="${illustration.width}"` : "";
  const h = Number.isInteger(illustration.height) && illustration.height > 0 ? ` height="${illustration.height}"` : "";
  return `<figure class="letter-illustration"><img src="${escapeHtml(illustration.src)}" alt=""${w}${h} loading="eager" decoding="sync" /></figure>`;
}

function blockHtml(b: LetterBlock, figure: string | null): string {
  switch (b.kind) {
    case "catch":
      return `<p class="letter-catch">${linesHtml(b.lines)}</p>`;
    case "concerns": {
      const head = b.heading === null ? "" : `<p class="letter-concerns-head">${escapeHtml(b.heading)}</p>`;
      const items = b.items.map((i) => `<li>${escapeHtml(i)}</li>`).join("");
      return `<div class="letter-concerns">${head}<ul>${items}</ul></div>`;
    }
    case "note":
      return `<div class="letter-note"><span class="letter-note-label">${LETTER_FIXED_TEXT.noteLabel}</span><p>${linesHtml(b.lines)}</p></div>`;
    case "ps":
      return `<p class="letter-ps">${linesHtml(b.lines)}</p>`;
    case "illustration":
      return figure ?? "";
    case "paragraph":
      return `<p>${linesHtml(b.lines)}</p>`;
  }
}

// 本文の枠組み(letter-layout の純関数)を HTML へ。絵の置き場所:
//   印があればその位置 / 無ければ最初の困りごとの枠の後 / それも無ければ本文の上。
//   困りごとの枠のすぐ後に絵が来るときは横に並べる(letter-row)=A4 1枚に収めるため。
function bodyHtml(body: string, illustration: LetterRenderInput["illustration"]): { html: string; basis: string | null } {
  const layout = parseLetterBody(body);
  const figure = illustrationHtml(illustration);
  let blocks = layout.blocks.filter((b) => b.kind !== "illustration" || figure !== null);
  if (figure && !layout.hasMarker) {
    const ci = blocks.findIndex((b) => b.kind === "concerns");
    const at = ci >= 0 ? ci + 1 : 0;
    blocks = [...blocks.slice(0, at), { kind: "illustration" }, ...blocks.slice(at)];
  }
  const out: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const next = blocks[i + 1];
    if (b.kind === "concerns" && next?.kind === "illustration" && figure) {
      out.push(`<div class="letter-row">${blockHtml(b, figure)}${figure}</div>`);
      i++;
      continue;
    }
    out.push(blockHtml(b, figure));
  }
  return { html: out.join("\n"), basis: layout.basis };
}

// テンプレ別の見た目(色/フォント)。枠組みは3つとも同じで、色と書体だけ違う。
// formal = 発注者が選んだ案A(緑・明朝)。soft/impact は書体と色だけ変える。
const TEMPLATE_VARS: Record<DesignTemplate, string> = {
  formal:
    "--accent:#2f6b4f; --tint:#f1f6f2; --line:#c9dccf; --font:'Yu Mincho','Hiragino Mincho ProN',serif;",
  soft: "--accent:#8a5a2b; --tint:#faf5ec; --line:#e0d2bd; --font:'Yu Gothic','Hiragino Sans',sans-serif;",
  impact:
    "--accent:#b3261e; --tint:#fbf1f0; --line:#e8c4c0; --font:'Yu Gothic','Hiragino Sans',sans-serif;",
};

// 紙面の CSS(A4 1枚・2026-10-17 発注者決定)。S はテンプレ別クラスのスコープ。
// 寸法は見本 PDF(scratchpad op/letter-design.cjs)で 4種類の文面が 1枚に収まることを確かめた値。
function pageCss(S: string): string {
  return `
    ${S} { box-sizing: border-box; width: 100%; min-height: 296.5mm; padding: 9mm 15mm 6mm; display: flex; flex-direction: column;
      font-family: var(--font); color: #222; font-size: 10pt; line-height: 1.5; background: #fff; }
    ${S} p { margin: 0 0 1.6mm; text-align: justify; }
    ${S} .letter-masthead { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid var(--accent); padding-bottom: 1.5mm; margin-bottom: 2.5mm; }
    ${S} .letter-brand { display: flex; align-items: baseline; gap: 3mm; }
    ${S} .letter-brand-name { font-weight: 700; font-size: 13pt; color: var(--accent); }
    ${S} .letter-brand-sub { font-size: 8.5pt; color: #666; }
    ${S} .letter-badge { font-size: 9.5pt; color: var(--accent); border: 1.5px solid var(--accent); border-radius: 999px; padding: 0.5mm 4mm; white-space: nowrap; }
    ${S} .letter-badge b { font-size: 12pt; margin-left: 1mm; }
    ${S} .letter-addr-block { margin-bottom: 2.5mm; }
    ${S} .letter-addr-lines { font-size: 9.5pt; color: #555; display: flex; gap: 4mm; }
    ${S} .letter-addressee { font-size: 14pt; font-weight: 700; margin-top: 1mm; }
    ${S} .letter-addressee small { font-size: 12pt; font-weight: 500; }
    ${S} .letter-catch { font-size: 12pt; line-height: 1.45; font-weight: 700; color: var(--accent); border-left: 2mm solid var(--accent); padding: 1mm 0 1mm 3.5mm; margin: 0 0 2.5mm; }
    ${S} .letter-concerns { background: var(--tint); border-radius: 2.5mm; padding: 2mm 4.5mm 1mm; margin: 0.5mm 0 2.5mm; }
    ${S} .letter-concerns-head { font-weight: 700; margin: 0 0 1.5mm; }
    ${S} .letter-concerns ul { list-style: none; margin: 0; padding: 0; }
    ${S} .letter-concerns li { position: relative; padding-left: 6mm; margin: 0 0 0.3mm; }
    ${S} .letter-concerns li::before { content: "\\2713"; position: absolute; left: 1mm; top: 0; color: var(--accent); font-weight: 700; }
    ${S} .letter-illustration { margin: 0 auto 2.5mm; width: 70mm; }
    ${S} .letter-row { display: flex; gap: 4mm; align-items: center; margin: 0.5mm 0 2.5mm; }
    ${S} .letter-row .letter-concerns { flex: 1; margin: 0; }
    ${S} .letter-row .letter-illustration { flex: none; width: 52mm; margin: 0; }
    ${S} .letter-illustration img { display: block; width: 100%; height: auto; border-radius: 1.5mm; }
    ${S} .letter-note { border: 1px solid var(--line); border-radius: 2.5mm; padding: 2.5mm 4.5mm 0.5mm; margin: 3.5mm 0 2.5mm; font-size: 9pt; line-height: 1.55; position: relative; }
    ${S} .letter-note-label { position: absolute; top: -3mm; left: 4mm; background: #fff; color: var(--accent); font-size: 8.5pt; padding: 0 1.5mm; font-weight: 700; }
    ${S} .letter-ps { font-size: 10.5pt; }
    ${S} .letter-sign { text-align: right; margin: 1mm 0 2.5mm; }
    ${S} .letter-sign-name { font-size: 12pt; font-weight: 700; color: var(--accent); }
    ${S} .letter-sign-sub { font-size: 9pt; color: #666; }
    ${S} .letter-contact { margin-top: auto; background: var(--tint); border-radius: 3mm; padding: 2.5mm 5mm 2mm; break-inside: avoid; }
    ${S} .letter-contact-head { font-weight: 700; font-size: 11.5pt; color: var(--accent); text-align: center; }
    ${S} .letter-contact-head span { font-size: 10pt; font-weight: 500; color: #444; margin-left: 3mm; }
    ${S} .letter-contact-ai { font-size: 8.5pt; color: #555; text-align: center; margin: 0.5mm 0 1.5mm; }
    ${S} .letter-contact-grid { display: flex; align-items: stretch; }
    ${S} .letter-contact-tel { flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; border-right: 1px solid var(--line); padding: 1mm 4mm; }
    ${S} .letter-label { font-size: 9pt; color: #555; }
    ${S} .letter-tel { font-size: 20pt; font-weight: 700; letter-spacing: 0.02em; line-height: 1.2; color: #111; margin: 0.5mm 0; overflow-wrap: anywhere; }
    ${S} .letter-tel--long { font-size: 13pt; }
    ${S} .letter-hint { font-size: 8.5pt; color: #555; line-height: 1.5; }
    ${S} .tracking-slot { flex: 1; display: flex; align-items: center; justify-content: center; padding: 1mm 4mm; }
    ${S} .sale-dm-tracking { display: flex; gap: 4mm; align-items: center; }
    ${S} .sale-dm-track-qr { width: 22mm; height: 22mm; flex: none; background: #fff; padding: 1.5mm; box-sizing: border-box; border-radius: 1mm; }
    ${S} .sale-dm-track-qr svg { width: 100%; height: 100%; display: block; }
    ${S} .sale-dm-track-text { max-width: 50mm; }
    ${S} .sale-dm-track-text p { margin: 0; text-align: left; }
    ${S} .sale-dm-track-caption { font-size: 9pt; color: #555; }
    ${S} .sale-dm-track-hint { font-size: 8.5pt; color: #555; line-height: 1.5; }
    ${S} .sale-dm-track-url { font-size: 6.5pt; color: #888; word-break: break-all; }
    ${S} .letter-footnote { display: flex; gap: 3mm; align-items: center; margin-top: 2mm; padding-top: 1.5mm; border-top: 1px dashed var(--line); font-size: 7.5pt; color: #666; line-height: 1.5; }
    ${S} .letter-footnote p { margin: 0; text-align: left; }
    ${S} .unsubscribe-slot { flex: 3; }
    ${S} .unsubscribe-slot:empty { display: none; }
    ${S} .sale-dm-unsubscribe { display: flex; gap: 3mm; align-items: center; }
    ${S} .sale-dm-unsub-qr { width: 11mm; height: 11mm; flex: none; background: #fff; padding: 0.8mm; box-sizing: border-box; }
    ${S} .sale-dm-unsub-url { font-size: 6.5pt; color: #888; word-break: break-all; }
    ${S} .letter-basis { flex: 2; }
    ${S} .letter-footer { text-align: center; margin-top: 2mm; }
    ${S} .letter-footer img { display: inline-block; width: 36mm; height: auto; vertical-align: top; }
  `;
}

// 1通分の HTML 断片。<style> はテンプレ別クラス(.letter-page--<design>)にスコープし、
// まとめ印刷で複数 <style> が並んでも相互干渉しないようにする。
export function renderLetterHtml(input: LetterRenderInput): string {
  const design = resolveDesignTemplate(input.designTemplate);
  const cls = `letter-page letter-page--${design}`;
  const S = `.letter-page--${design}`;
  const T = LETTER_FIXED_TEXT;

  const addressee = `${escapeHtml(input.addresseeName)} <small>${escapeHtml(input.honorific)}</small>`;
  const zip = input.recipientZip ? `<span>〒${escapeHtml(input.recipientZip)}</span>` : "";
  const address = input.recipientAddress ? `<span>${escapeHtml(input.recipientAddress)}</span>` : "";
  // 画面の見本は差出人を空で渡す(印刷時に設定から入る)。空のままだと電話の欄が消えて紙面が崩れるので仮の文字を出す。
  const sender = escapeHtml(input.senderName.trim() || T.senderPlaceholder);
  const contactText = input.senderContact.trim() || T.contactPlaceholder;
  const contact = escapeHtml(contactText);
  // 連絡先は設定の自由文(「TEL 03-… (平日 9-18時)」のような長い値もあり得る)。電話番号の長さを超えるときは小さくして、
  // 問い合わせ枠が縦に伸びてロゴが2枚目へ押し出されるのを防ぐ。
  const telCls = contactText.length > 16 ? "letter-tel letter-tel--long" : "letter-tel";
  const body = bodyHtml(input.body, input.illustration);
  const logo = LP_BRAND.logo;

  return `<div class="${cls}">
  <style>
    ${S} { ${TEMPLATE_VARS[design]} }
    ${pageCss(S)}
  </style>
  <div class="letter-masthead">
    <div class="letter-brand"><span class="letter-brand-name">${sender}</span><span class="letter-brand-sub">${T.tagline}</span></div>
    <div class="letter-badge">${T.badge}<b>${T.badgeStrong}</b></div>
  </div>
  <div class="letter-addr-block">
    <div class="letter-addr-lines">${zip}${address}</div>
    <div class="letter-addressee">${addressee}</div>
  </div>
  <div class="letter-body">${body.html}</div>
  <div class="letter-sign">
    <div class="letter-sign-name">${sender}</div>
    <div class="letter-sign-sub">${T.tagline}</div>
  </div>
  <div class="letter-contact">
    <div class="letter-contact-head">${T.contactHead}<span>${T.contactSub}</span></div>
    <div class="letter-contact-ai">${T.aiLine}</div>
    <div class="letter-contact-grid">
      <div class="letter-contact-tel">
        <div class="letter-label">${T.telLabel}</div>
        <div class="${telCls}">${contact}</div>
        <div class="letter-hint">${T.telHint}</div>
      </div>
      <!--
        TRACKING SLOT: 宛先固有の追跡QR/短縮URL を差し込む枠。
        data-tracking-token は opaque トークン(PII 非含有)。中身 trackingSlotHtml は
        呼び出し側(印刷route)が renderTrackingSlotHtml で生成した信頼済み HTML 断片。
        未指定なら空(URL/QR を描かない=単体レンダリング時は生URLを載せない)。
      -->
      <div class="tracking-slot" data-tracking-token="${escapeHtml(input.trackingToken)}">
        ${input.trackingSlotHtml ?? ""}
      </div>
    </div>
    <div class="letter-footnote">
      <div class="unsubscribe-slot">${input.unsubscribeSlotHtml ?? ""}</div>
      ${body.basis === null ? "" : `<p class="letter-basis">${escapeHtml(body.basis)}</p>`}
    </div>
  </div>
  <div class="letter-footer"><img src="${logo.src}" alt="${escapeHtml(logo.alt)}" width="${logo.width}" height="${logo.height}" loading="eager" decoding="sync" /></div>
</div>`;
}

// 確定済みの全通を1ドキュメントへ連結する(ブラウザ印刷 = PDF 化の入力)。
// 各通は A4 1枚。通と通の間だけ page-break-after:always を入れ、最後の通には付けない
// (末尾に空白ページが1枚増えるのを防ぐ)。<style> の @page で余白とサイズを固定。
export function renderLetterSheetHtml(
  title: string,
  letters: LetterRenderInput[],
): string {
  const items = letters
    .map((letter, i) => {
      const isLast = i === letters.length - 1;
      const wrapCls = isLast
        ? "letter-sheet-item"
        : "letter-sheet-item letter-sheet-item--break";
      const style = isLast
        ? ""
        : ' style="page-break-after: always; break-after: page;"';
      return `<div class="${wrapCls}"${style}>${renderLetterHtml(letter)}</div>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="robots" content="noindex,nofollow" />
<title>${escapeHtml(title)}</title>
<style>
  @page { size: A4; margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; }
  .letter-sheet-item { break-inside: avoid; }
  @media screen {
    body { background: #eee; }
    .letter-sheet-item { width: 210mm; margin: 8mm auto; background: #fff; box-shadow: 0 0 4px rgba(0,0,0,.2); }
  }
</style>
</head>
<body>
${items}
</body>
</html>`;
}

export type { LetterRenderInput } from "./types";
