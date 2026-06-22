import type { LetterRenderInput } from "./types";

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

// 改行を <br /> へ。先に escapeHtml 済みの文字列に対して適用する。
function escapedBodyToHtml(body: string): string {
  return escapeHtml(body).replace(/\r\n|\r|\n/g, "<br />\n");
}

// テンプレ別の見た目(色/フォント/装飾)。可変要素は CSS 変数で持ち、将来 調整パネルから
// 上書きできるよう設計(本プランでは固定値)。
const TEMPLATE_VARS: Record<DesignTemplate, string> = {
  // 信頼: 明朝・落ち着いた紺・罫線控えめ。
  formal:
    "--accent:#1f3a5f; --font:'Yu Mincho','Hiragino Mincho ProN',serif; --body-size:11pt; --line:1.9;",
  // やわらか: ゴシック・温かみのある色・余白広め・角丸。
  soft: "--accent:#9a6a3a; --font:'Yu Gothic','Hiragino Sans',sans-serif; --body-size:11.5pt; --line:2.0;",
  // インパクト: 太字見出し・コントラスト強め。
  impact:
    "--accent:#b3261e; --font:'Yu Gothic','Hiragino Sans',sans-serif; --body-size:11.5pt; --line:1.8;",
};

// 1通分の HTML 断片。<style> はテンプレ別クラス(.letter-page--<design>)にスコープし、
// まとめ印刷で複数 <style> が並んでも相互干渉しないようにする。
export function renderLetterHtml(input: LetterRenderInput): string {
  const design = resolveDesignTemplate(input.designTemplate);
  const cls = `letter-page letter-page--${design}`;
  const vars = TEMPLATE_VARS[design];

  const addressee = `${escapeHtml(input.addresseeName)} ${escapeHtml(input.honorific)}`;
  const zip = input.recipientZip ? `〒${escapeHtml(input.recipientZip)}` : "";
  const address = escapeHtml(input.recipientAddress);
  const sender = escapeHtml(input.senderName);
  const contact = escapeHtml(input.senderContact);
  const bodyHtml = escapedBodyToHtml(input.body);

  return `<div class="${cls}">
  <style>
    .letter-page--${design} { ${vars} }
    .letter-page--${design} {
      box-sizing: border-box; width: 100%; min-height: 257mm; padding: 22mm 20mm;
      font-family: var(--font); color: #222; line-height: var(--line); font-size: var(--body-size);
    }
    .letter-page--${design} .letter-addr-block { margin-bottom: 14mm; }
    .letter-page--${design} .letter-zip { font-size: 10pt; color: #555; }
    .letter-page--${design} .letter-addr { font-size: 10pt; color: #555; }
    .letter-page--${design} .letter-addressee { margin-top: 4mm; font-size: 13pt; font-weight: 700; color: var(--accent); }
    .letter-page--${design} .letter-body { white-space: normal; }
    .letter-page--${design} .letter-sender { margin-top: 16mm; text-align: right; }
    .letter-page--${design} .letter-sender-name { font-weight: 700; color: var(--accent); }
    .letter-page--${design} .letter-sender-contact { font-size: 10pt; color: #555; }
    .letter-page--${design} .tracking-slot {
      margin-top: 12mm; padding: 6mm; border: 1px dashed #bbb; text-align: center;
      font-size: 9pt; color: #999;
    }
  </style>
  <div class="letter-addr-block">
    <div class="letter-zip">${zip}</div>
    <div class="letter-addr">${address}</div>
    <div class="letter-addressee">${addressee}</div>
  </div>
  <div class="letter-body">${bodyHtml}</div>
  <div class="letter-sender">
    <div class="letter-sender-name">${sender}</div>
    <div class="letter-sender-contact">${contact}</div>
  </div>
  <!--
    TRACKING SLOT (Plan 5): 宛先固有の追跡QR/短縮URL をここに差し込む。
    data-tracking-token は Plan 5 のレンダラ拡張が参照する識別子。
    本プランでは枠のみで、URL/QR は描画しない(opaque トークンを生URLとして載せない)。
  -->
  <div class="tracking-slot" data-tracking-token="${escapeHtml(input.trackingToken)}">
    [ 追跡QR / 短縮URL は後日掲載 ]
  </div>
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
