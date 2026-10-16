import { describe, it, expect } from "vitest";
import {
  renderLetterHtml,
  renderLetterSheetHtml,
  escapeHtml,
  DESIGN_TEMPLATES,
  resolveDesignTemplate,
} from "../sale-dm-letter/templates";
import type { LetterRenderInput } from "../sale-dm-letter/templates/types";
import { LETTER_FIXED_TEXT } from "../sale-dm-letter/letter-layout";

const base: LetterRenderInput = {
  designTemplate: "formal",
  body: "拝啓 時下ますますご清栄のこととお慶び申し上げます。\n2行目の本文です。",
  addresseeName: "田中 一郎",
  honorific: "様",
  recipientZip: "100-0001",
  recipientAddress: "東京都〇〇区△△1-2-3",
  senderName: "△△不動産",
  senderContact: "000-000-0000",
  trackingToken: "tok_abc",
};

describe("escapeHtml", () => {
  it("HTML 特殊文字を実体参照へ変換する", () => {
    expect(escapeHtml(`<script>"a&b"'c'`)).toBe(
      "&lt;script&gt;&quot;a&amp;b&quot;&#39;c&#39;",
    );
  });
  it("null / undefined は空文字", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
});

describe("resolveDesignTemplate", () => {
  it("既知の3種はそのまま", () => {
    expect(resolveDesignTemplate("soft")).toBe("soft");
    expect(resolveDesignTemplate("impact")).toBe("impact");
    expect(resolveDesignTemplate("formal")).toBe("formal");
  });
  it("未知値は formal にフォールバック", () => {
    expect(resolveDesignTemplate("unknown")).toBe("formal");
  });
});

describe("renderLetterHtml", () => {
  it("3デザインとも宛名・本文・差出人を含む完結した断片を返す", () => {
    for (const design of DESIGN_TEMPLATES) {
      const html = renderLetterHtml({ ...base, designTemplate: design });
      expect(html).toContain("letter-page");
      expect(html).toContain(`letter-page--${design}`);
      expect(html).toContain("田中 一郎");
      expect(html).toContain("様");
      expect(html).toContain("△△不動産");
      // 本文の改行が <br> へ展開される
      expect(html).toContain("2行目の本文です。");
      expect(html).toContain("<br");
    }
  });

  it("HTML エスケープ: 本文の <script> はそのまま出力されない", () => {
    const html = renderLetterHtml({
      ...base,
      body: '<script>alert("x")</script>悪意ある本文',
      addresseeName: 'タグ<b>"&名',
    });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("悪意ある本文");
    expect(html).toContain("タグ&lt;b&gt;&quot;&amp;名");
  });

  it("追跡リンクの差し込み枠(プレースホルダ)を持つが URL/QR は描かない", () => {
    const html = renderLetterHtml(base);
    expect(html).toContain("tracking-slot");
    // trackingSlotHtml 未指定なら実 URL は載せない(トークンを生の URL として出さない)
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
  });

  it("trackingSlotHtml を渡すと追跡枠に差し込まれる(印刷route の配線)", () => {
    const html = renderLetterHtml({
      ...base,
      trackingSlotHtml: '<div class="sale-dm-tracking">QRここ</div>',
    });
    expect(html).toContain('<div class="sale-dm-tracking">QRここ</div>');
  });

  it("未知の designTemplate でも落ちず formal にフォールバックして描画する", () => {
    const html = renderLetterHtml({ ...base, designTemplate: "nope" });
    expect(html).toContain("letter-page--formal");
  });
});

// 紙面(2026-10-17 発注者決定: 案A=緑・A4 1枚・社名の帯・困りごとの枠と絵を横並び・問い合わせ枠・ロゴは下の中央)
describe("renderLetterHtml の紙面", () => {
  const BODY = [
    "相続したご実家を売るなら、特例があり、期限が決まっています。",
    "",
    "〇〇の不動産を相続された方へ、このお手紙をお送りしております。",
    "",
    "このようなお困りごとはありませんか。",
    "・実家に通うのが負担",
    "・固定資産税がかかり続けている",
    "",
    "【イラスト】",
    "",
    "弊社では、まずはお話を伺うところから始めています。",
    "",
    "なお、特例があります。確定申告が必要です。",
    "",
    "このお手紙は、公開されている不動産登記の情報をもとにお送りしております。",
    "",
    "追伸　お気軽にお申し込みください。",
  ].join("\n");
  const ILL = { src: "/lp-assets/0123456789abcdef0123456789abcdef", width: 1600, height: 807 };
  const html = renderLetterHtml({ ...base, body: BODY, illustration: ILL, trackingSlotHtml: '<div class="sale-dm-tracking">QR</div>', unsubscribeSlotHtml: '<div class="sale-dm-unsubscribe">STOP</div>' });
  const between = (s: string, a: string, b: string) => s.slice(s.indexOf(a), s.indexOf(b, s.indexOf(a)));

  it("上の帯: 差出人名+添え書き+「査定・ご相談 無料」の札", () => {
    const head = between(html, 'class="letter-masthead"', 'class="letter-addr-block"');
    expect(head).toContain("△△不動産");
    expect(head).toContain(LETTER_FIXED_TEXT.tagline);
    expect(head).toContain(LETTER_FIXED_TEXT.badge);
    expect(head).toContain(`<b>${LETTER_FIXED_TEXT.badgeStrong}</b>`);
  });

  it("本文: 最初の段落=キャッチ / ・=困りごと(✓の li) / なお=ご参考 / 追伸", () => {
    const body = between(html, 'class="letter-body"', 'class="letter-sign"');
    expect(body).toContain('class="letter-catch"');
    expect(between(body, 'class="letter-catch"', "</p>")).toContain("相続したご実家を売るなら");
    expect(body).toContain('class="letter-concerns"');
    expect(body).toContain("<li>実家に通うのが負担</li>");
    expect(body).toContain("<li>固定資産税がかかり続けている</li>");
    expect(body).toContain('class="letter-concerns-head"');
    expect(body).toContain('class="letter-note"');
    expect(body).toContain(LETTER_FIXED_TEXT.noteLabel);
    expect(body).toContain('class="letter-ps"');
    expect(body).toContain("追伸　お気軽にお申し込みください。");
  });

  it("絵は困りごとの枠のすぐ後なら横並び(letter-row)。縦横比は元のまま(height:auto)", () => {
    const body = between(html, 'class="letter-body"', 'class="letter-sign"');
    const row = between(body, 'class="letter-row"', "</figure>");
    expect(row).toContain('class="letter-concerns"');
    expect(row).toContain("<img");
    // 縦横比は元のまま(width/height とも auto)で、高さだけ上限(縦長の絵が紙面を占領しない・@codex #524 P2)
    expect(html).toMatch(/\.letter-illustration img \{[^}]*width: auto[^}]*height: auto/);
    expect(html).toMatch(/\.letter-illustration img \{[^}]*max-height: 55mm/);
    expect(html).not.toContain("object-fit");
  });

  it("QR は読める大きさ: 無料査定 22mm 箱(余白込み)・配信停止は記号 15mm 以上(マニュアルの約15mm以上に合わせる・@codex #524 P1)", () => {
    expect(html).toMatch(/\.sale-dm-track-qr \{[^}]*width: 22mm; height: 22mm/);
    const m = html.match(/\.sale-dm-unsub-qr \{[^}]*width: (\d+(?:\.\d+)?)mm; height: [\d.]+mm[^}]*padding: (\d+(?:\.\d+)?)mm/);
    expect(m).not.toBeNull();
    expect(Number(m![1]) - 2 * Number(m![2])).toBeGreaterThanOrEqual(15);
  });

  it("登記情報の一文は本文から外れ、問い合わせ枠の下の脚注に出る", () => {
    const body = between(html, 'class="letter-body"', 'class="letter-sign"');
    expect(body).not.toContain("公開されている不動産登記");
    const foot = between(html, 'class="letter-footnote"', 'class="letter-footer"');
    expect(foot).toContain("このお手紙は、公開されている不動産登記の情報をもとにお送りしております。");
    expect(foot).toContain('<div class="sale-dm-unsubscribe">STOP</div>');
  });

  it("問い合わせ枠: 見出し・AI査定の一文・電話番号・追跡枠(無料査定QR)", () => {
    const c = between(html, 'class="letter-contact"', 'class="letter-footnote"');
    expect(c).toContain(LETTER_FIXED_TEXT.contactHead);
    expect(c).toContain(LETTER_FIXED_TEXT.contactSub);
    expect(c).toContain(LETTER_FIXED_TEXT.aiLine);
    expect(c).toContain("000-000-0000");
    expect(c).toContain(LETTER_FIXED_TEXT.telHint);
    expect(c).toContain('class="tracking-slot"');
    expect(c).toContain('<div class="sale-dm-tracking">QR</div>');
  });

  it("下の中央に会社のロゴ(公開LPと同じ画像・元の縦横比)", () => {
    const f = between(html, 'class="letter-footer"', "</div>");
    expect(f).toContain('src="/lp-assets/brand/logo.png"');
    expect(f).toContain('width="1664"');
    expect(f).toContain('height="243"');
    expect(html).toMatch(/\.letter-footer img \{[^}]*height: auto/);
  });

  it("A4 1枚の形(297mm より僅かに低い=端数で白紙が増えない)で、3デザインとも同じ枠組み・色だけ違う(formal=緑)", () => {
    for (const design of DESIGN_TEMPLATES) {
      const h = renderLetterHtml({ ...base, body: BODY, designTemplate: design });
      expect(h).toContain("min-height: 296.5mm");
      expect(h).not.toContain("overflow: hidden");
      expect(h).toContain('class="letter-masthead"');
      expect(h).toContain('class="letter-contact"');
      expect(h).toContain('class="letter-footer"');
      expect(h).toContain("--accent:");
    }
    expect(renderLetterHtml({ ...base, designTemplate: "formal" })).toContain("--accent:#2f6b4f");
  });

  it("画面の見本(差出人が空)でも電話の欄が空にならず、仮の文字が出る", () => {
    const h = renderLetterHtml({ ...base, body: BODY, senderName: "", senderContact: "" });
    expect(h).toContain(LETTER_FIXED_TEXT.senderPlaceholder);
    expect(h).toContain(LETTER_FIXED_TEXT.contactPlaceholder);
  });

  it("連絡先が長い自由文なら電話の欄を小さくする(問い合わせ枠が伸びてロゴが2枚目へ行かないように)", () => {
    expect(renderLetterHtml({ ...base, senderContact: "03-6823-2760" })).toContain('class="letter-tel">');
    expect(renderLetterHtml({ ...base, senderContact: "TEL 03-6823-2760（平日 10:00〜19:00）" })).toContain('class="letter-tel letter-tel--long">');
    expect(renderLetterHtml(base)).toMatch(/\.letter-tel \{[^}]*overflow-wrap: anywhere/);
  });

  it("本文の HTML は全部エスケープされる(見出し・困りごと・ご参考・脚注)", () => {
    const h = renderLetterHtml({
      ...base,
      body: "<b>見出し</b>\n\n困り<i>ごと</i>\n・<u>項目</u>\n\nなお、<s>特例</s>\n\nこのお手紙は、公開されている<x>情報</x>",
    });
    expect(h).not.toMatch(/<[ius]>/);
    expect(h).not.toContain("<b>見出し");
    expect(h).not.toContain("<x>");
    expect(h).toContain("&lt;b&gt;見出し&lt;/b&gt;");
    expect(h).toContain("<li>&lt;u&gt;項目&lt;/u&gt;</li>");
    expect(h).toContain("&lt;x&gt;情報&lt;/x&gt;");
  });

  it("unsubscribeSlotHtml が無ければ停止枠は空(URL を描かない)", () => {
    const h = renderLetterHtml({ ...base, body: BODY });
    expect(h).toContain('class="unsubscribe-slot"');
    expect(h).not.toContain("http");
  });
});

describe("renderLetterSheetHtml", () => {
  const make = (name: string): LetterRenderInput => ({ ...base, addresseeName: name });

  it("完全な HTML ドキュメント(doctype + @page)を返す", () => {
    const html = renderLetterSheetHtml("テストキャンペーン", [make("田中"), make("佐藤")]);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>テストキャンペーン</title>");
    expect(html).toContain("@page");
    expect(html).toContain("page-break-after");
  });

  it("通数ぶんの letter-page を連結する", () => {
    const html = renderLetterSheetHtml("c", [make("A"), make("B"), make("C")]);
    const count = (html.match(/class="letter-page /g) ?? []).length;
    expect(count).toBe(3);
  });

  it("最後の通は page-break を付けない(末尾空白ページ回避)", () => {
    const html = renderLetterSheetHtml("c", [make("A"), make("B")]);
    const breaks = (html.match(/letter-sheet-item--break/g) ?? []).length;
    expect(breaks).toBe(1); // 2通中、区切りは1つ
  });

  it("0通でも落ちず空ドキュメントを返す", () => {
    const html = renderLetterSheetHtml("空", []);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toContain("class=\"letter-page ");
  });

  it("タイトルも HTML エスケープされる", () => {
    const html = renderLetterSheetHtml("<b>x</b>", []);
    expect(html).toContain("<title>&lt;b&gt;x&lt;/b&gt;</title>");
  });
});
