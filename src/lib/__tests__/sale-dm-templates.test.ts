import { describe, it, expect } from "vitest";
import {
  renderLetterHtml,
  renderLetterSheetHtml,
  escapeHtml,
  DESIGN_TEMPLATES,
  resolveDesignTemplate,
} from "../sale-dm-letter/templates";
import type { LetterRenderInput } from "../sale-dm-letter/templates/types";

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
    // Plan 5 まで実 URL は載せない(トークンを生の URL として出さない)
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
  });

  it("未知の designTemplate でも落ちず formal にフォールバックして描画する", () => {
    const html = renderLetterHtml({ ...base, designTemplate: "nope" });
    expect(html).toContain("letter-page--formal");
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
