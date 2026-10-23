import { describe, expect, it } from "vitest";
import { esc, html, raw } from "../html";

describe("書類の HTML の組み立て(差し込む値は必ず無害化)", () => {
  it("差し込む文字の < > & \" ' をエスケープする", () => {
    expect(html`<p>${`<script>alert("x")</script>&'`}</p>`.__html).toBe(
      "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;</p>",
    );
    expect(esc("a<b")).toBe("a&lt;b");
  });

  it("属性の中に入れても抜け出せない", () => {
    expect(html`<td title="${'" onclick="x'}">`.__html).toBe('<td title="&quot; onclick=&quot;x">');
  });

  it("数字はそのまま・null/undefined/false は何も出さない・配列は連結", () => {
    expect(html`${1}|${null}|${undefined}|${false}|${["<a>", html`<b>`]}`.__html).toBe("1||||&lt;a&gt;<b>");
  });

  it("入れ子の html と raw だけは素通し", () => {
    const inner = html`<i>${"<x>"}</i>`;
    expect(html`<p>${inner}${raw("<br>")}</p>`.__html).toBe("<p><i>&lt;x&gt;</i><br></p>");
  });

  it("中身が __html を持つだけのただの物は素通ししない(偽物の印を通さない)", () => {
    const fake = JSON.parse('{"__html":"<script>"}') as unknown as string;
    expect(html`${fake}`.__html).not.toContain("<script>");
  });
});
