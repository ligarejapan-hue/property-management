import { describe, it, expect } from "vitest";
import { sanitizeCssValue, isSafeImageSrc } from "../css-safety";

describe("sanitizeCssValue", () => {
  it("; を除去する（CSS宣言注入防止）", () => {
    expect(sanitizeCssValue("red;background-image:url(http://evil/)")).toBe("redbackground-image:url(http://evil/)");
  });

  it("{ } を除去する（ブロック注入防止）", () => {
    expect(sanitizeCssValue("x{color:red}")).toBe("xcolor:red");
  });

  it("< > を除去する（HTMLタグブレイクアウト防止）", () => {
    // < と > の両方が除去される; </style><script> → /stylescript
    expect(sanitizeCssValue("</style><script>alert(1)</script>")).toBe("/stylescriptalert(1)/script");
  });

  it("\\ を除去する", () => {
    expect(sanitizeCssValue("foo\\bar")).toBe("foobar");
  });

  it("制御文字(\\x00-\\x1f)を除去する", () => {
    expect(sanitizeCssValue("red\x00green\x1f")).toBe("redgreen");
  });

  it("#fff を保持する", () => {
    expect(sanitizeCssValue("#fff")).toBe("#fff");
  });

  it("rgb(0,0,0) を保持する", () => {
    expect(sanitizeCssValue("rgb(0,0,0)")).toBe("rgb(0,0,0)");
  });

  it('"Yu Gothic UI",sans-serif を保持する', () => {
    expect(sanitizeCssValue('"Yu Gothic UI",sans-serif')).toBe('"Yu Gothic UI",sans-serif');
  });

  it("#1f4e79 を保持する", () => {
    expect(sanitizeCssValue("#1f4e79")).toBe("#1f4e79");
  });

  it("複数の注入文字を同時に除去する", () => {
    expect(sanitizeCssValue("red;background:url(x)")).not.toContain(";");
  });
});

describe("isSafeImageSrc (Plan1: data:image/ のみ)", () => {
  it("data:image/png;base64,AAAA を許可する", () => {
    expect(isSafeImageSrc("data:image/png;base64,AAAA")).toBe(true);
  });

  it("data:image/jpeg;base64,/9j/ を許可する", () => {
    expect(isSafeImageSrc("data:image/jpeg;base64,/9j/")).toBe(true);
  });

  it("/uploads/p/1.jpg を拒否する (Plan2 で対応)", () => {
    expect(isSafeImageSrc("/uploads/p/1.jpg")).toBe(false);
  });

  it("/images/photo.png を拒否する (root-relative は Plan2)", () => {
    expect(isSafeImageSrc("/images/photo.png")).toBe(false);
  });

  it("http://internal/x を拒否する（SSRF）", () => {
    expect(isSafeImageSrc("http://internal/x")).toBe(false);
  });

  it("http://169.254.169.254/metadata を拒否する（SSRF）", () => {
    expect(isSafeImageSrc("http://169.254.169.254/metadata")).toBe(false);
  });

  it("https://evil.example.com/x を拒否する", () => {
    expect(isSafeImageSrc("https://evil.example.com/x")).toBe(false);
  });

  it("javascript:alert(1) を拒否する（XSS）", () => {
    expect(isSafeImageSrc("javascript:alert(1)")).toBe(false);
  });

  it("//evil.com/x を拒否する（プロトコル相対）", () => {
    expect(isSafeImageSrc("//evil.com/x")).toBe(false);
  });
});
