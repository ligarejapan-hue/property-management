import { describe, it, expect } from "vitest";
import { sanitizeCssValue, isSafeImageSrc, isCssColor, isSafeFontFamily } from "../css-safety";

describe("sanitizeCssValue", () => {
  it("; を除去する（CSS宣言注入防止）", () => {
    expect(sanitizeCssValue("red;background-image:url(http://evil/)")).toBe("redbackground-image:http://evil/)");
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

  it('url(http://169.254.169.254/) から url( を除去する (SSRF防止)', () => {
    const result = sanitizeCssValue("url(http://169.254.169.254/)");
    expect(result).not.toContain("url(");
    expect(result).not.toContain("url (");
  });

  it("URL ( ... ) (大文字＋スペース) からも url( を除去する", () => {
    const result = sanitizeCssValue("URL ( http://x )");
    expect(result.toLowerCase()).not.toContain("url(");
  });

  it("@import 'http://evil' から @import を除去する", () => {
    const result = sanitizeCssValue("@import 'http://evil'");
    expect(result).not.toContain("@import");
  });
});

describe("isCssColor (許可リスト)", () => {
  it.each(["#d0331a", "#fff", "rgb(0,0,0)", "rgba(0,0,0,0.5)", "hsl(0,0%,0%)", "red", "transparent", "currentColor"])(
    "%s を許可する",
    (v) => expect(isCssColor(v)).toBe(true),
  );

  it.each([
    "url(http://x)",
    'image-set("http://169.254.169.254/latest" 1x)',
    "red;background:url(x)",
    "a:b",
    "#xyz",
    "",
  ])("%s を拒否する", (v) => expect(isCssColor(v)).toBe(false));
});

describe("isSafeFontFamily (許可リスト)", () => {
  it.each(['"Yu Gothic UI","Meiryo",sans-serif', "sans-serif"])(
    "%s を許可する",
    (v) => expect(isSafeFontFamily(v)).toBe(true),
  );

  it.each(['image-set("http://x")', "a</style>b", "x:y", "f/g"])(
    "%s を拒否する",
    (v) => expect(isSafeFontFamily(v)).toBe(false),
  );
});

describe("isSafeImageSrc (Plan3: data:image/ と /uploads/ を許可)", () => {
  // --- 許可すべき src ---
  it("data:image/png;base64,AAAA を許可する", () => {
    expect(isSafeImageSrc("data:image/png;base64,AAAA")).toBe(true);
  });

  it("data:image/jpeg;base64,/9j/ を許可する", () => {
    expect(isSafeImageSrc("data:image/jpeg;base64,/9j/")).toBe(true);
  });

  it("/uploads/abc.jpg を許可する（アプリ内蔵ストレージ）", () => {
    expect(isSafeImageSrc("/uploads/abc.jpg")).toBe(true);
  });

  it("/uploads/p/1.jpg を許可する（アプリ内蔵ストレージ・サブディレクトリ）", () => {
    expect(isSafeImageSrc("/uploads/p/1.jpg")).toBe(true);
  });

  it("/uploads/sub/dir/photo.png を許可する（ネストパス）", () => {
    expect(isSafeImageSrc("/uploads/sub/dir/photo.png")).toBe(true);
  });

  // --- 拒否すべき src（セキュリティ境界の網羅テスト）---
  it("//evil.com/x.jpg を拒否する（プロトコル相対URL）", () => {
    expect(isSafeImageSrc("//evil.com/x.jpg")).toBe(false);
  });

  it("/uploads/../../etc/passwd を拒否する（パストラバーサル）", () => {
    expect(isSafeImageSrc("/uploads/../../etc/passwd")).toBe(false);
  });

  it("/uploads/%2e%2e/etc/passwd を拒否する（パーセントエンコードされた traversal）", () => {
    expect(isSafeImageSrc("/uploads/%2e%2e/etc/passwd")).toBe(false);
    expect(isSafeImageSrc("/uploads/%2E%2E/x")).toBe(false); // 大文字エンコードも拒否
  });

  it("http://x/y.jpg を拒否する（SSRF: http scheme）", () => {
    expect(isSafeImageSrc("http://x/y.jpg")).toBe(false);
  });

  it("https://x/y.jpg を拒否する（SSRF: https scheme）", () => {
    expect(isSafeImageSrc("https://x/y.jpg")).toBe(false);
  });

  it("javascript:alert(1) を拒否する（XSS）", () => {
    expect(isSafeImageSrc("javascript:alert(1)")).toBe(false);
  });

  it("\\uploads\\x を拒否する（バックスラッシュ区切り）", () => {
    expect(isSafeImageSrc("\\uploads\\x")).toBe(false);
  });

  it("/uploadsX/y を拒否する（/uploads/ 接頭辞の部分一致は不可）", () => {
    expect(isSafeImageSrc("/uploadsX/y")).toBe(false);
  });

  it("/uploads/<script> を拒否する（< を含む）", () => {
    expect(isSafeImageSrc("/uploads/<script>")).toBe(false);
  });

  it("/uploads/foo bar.jpg を拒否する（空白を含む）", () => {
    expect(isSafeImageSrc("/uploads/foo bar.jpg")).toBe(false);
  });

  it("data:text/html,<script> を拒否する（data:image/ でない data: URL）", () => {
    expect(isSafeImageSrc("data:text/html,<script>")).toBe(false);
  });

  it("/images/photo.png を拒否する（/uploads/ 以外の root-relative）", () => {
    expect(isSafeImageSrc("/images/photo.png")).toBe(false);
  });

  it("http://internal/x を拒否する（SSRF）", () => {
    expect(isSafeImageSrc("http://internal/x")).toBe(false);
  });

  it("http://169.254.169.254/metadata を拒否する（SSRF: IMDSv1）", () => {
    expect(isSafeImageSrc("http://169.254.169.254/metadata")).toBe(false);
  });

  it("https://evil.example.com/x を拒否する（外部URL）", () => {
    expect(isSafeImageSrc("https://evil.example.com/x")).toBe(false);
  });

  it("//evil.com/x を拒否する（プロトコル相対）", () => {
    expect(isSafeImageSrc("//evil.com/x")).toBe(false);
  });
});
