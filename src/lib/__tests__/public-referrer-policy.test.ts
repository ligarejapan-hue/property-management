/**
 * 公開ページ(/t/ /u/ /lp/ /lp-assets/ /submit/)の Referrer-Policy が、コードの意図どおりに届くことのピン。
 *
 * ⚠Next の next.config の headers() は route の応答ヘッダより強い(同じキーなら後ろのルールが勝つ・#631 で `next start` の実物で確認)。
 *   全体(/:path*)の strict-origin-when-cross-origin が、route で付けた strict-origin を上書きしていた。
 * ⚠nginx も server ブロックの add_header を、自分の add_header を持たない location へ引き継ぐ。
 *   上流の値のあとに足されるので、ブラウザは後ろの値(=全体の値)を使う。公開の location には自分の add_header が要る。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import nextConfig from "../../../next.config";
import { PUBLIC_PAGE_HEADERS } from "../sale-dm-letter/unsubscribe-page";
import { JSON_HEADERS } from "../sale-dm-letter/inquiry-http";
import { LP_PAGE_HEADERS } from "../sale-dm-letter/lp-page";
import { submitHeaders } from "../deals/doc-links/public-page";

const SUBMIT_HEADERS = submitHeaders("text/html; charset=utf-8");

type Rule = { source: string; headers: { key: string; value: string }[] };

async function rules(): Promise<Rule[]> {
  return (await (nextConfig as { headers: () => Promise<Rule[]> }).headers());
}

/** "/:path*" と "/x/:path*" の形だけを解釈する(ほかの形があればテストが落ちる=解釈を足す)。 */
function matches(source: string, p: string): boolean {
  if (source === "/:path*") return true;
  const m = /^(\/[a-z-]+)\/:path\*$/.exec(source);
  if (!m) throw new Error(`未対応の source: ${source}`);
  return p === m[1] || p.startsWith(`${m[1]}/`);
}

/** Next と同じく、当たるルールを順に当て、同じキーは後ろが勝つ。 */
async function effective(p: string, key: string): Promise<string | undefined> {
  let v: string | undefined;
  for (const r of await rules()) {
    if (!matches(r.source, p)) continue;
    for (const h of r.headers) if (h.key.toLowerCase() === key.toLowerCase()) v = h.value;
  }
  return v;
}

describe("公開ページの Referrer-Policy(next.config の全体の指定に負けない)", () => {
  const cases: [string, string][] = [
    ["/t/abc", LP_PAGE_HEADERS["Referrer-Policy"]],
    ["/t/abc/inquiry", JSON_HEADERS["Referrer-Policy"]],
    ["/t/abc/phone-tap", PUBLIC_PAGE_HEADERS["Referrer-Policy"]],
    ["/u/abc", PUBLIC_PAGE_HEADERS["Referrer-Policy"]],
    ["/lp/some-slug", LP_PAGE_HEADERS["Referrer-Policy"]],
    ["/lp/some-slug/inquiry", JSON_HEADERS["Referrer-Policy"]],
    ["/lp-assets/0123456789abcdef", "strict-origin"],
    ["/submit/abc", SUBMIT_HEADERS["Referrer-Policy"]],
  ];
  for (const [p, want] of cases) {
    it(`${p} は ${want}`, async () => {
      expect(await effective(p, "Referrer-Policy")).toBe(want);
    });
  }

  it("route 側の意図は strict-origin(/submit/ だけ no-referrer)", () => {
    expect(PUBLIC_PAGE_HEADERS["Referrer-Policy"]).toBe("strict-origin");
    expect(LP_PAGE_HEADERS["Referrer-Policy"]).toBe("strict-origin");
    expect(JSON_HEADERS["Referrer-Policy"]).toBe("strict-origin");
    expect(SUBMIT_HEADERS["Referrer-Policy"]).toBe("no-referrer");
  });

  it("社内の画面は今までどおり strict-origin-when-cross-origin", async () => {
    for (const p of ["/", "/properties", "/deals/x", "/api/properties", "/tx/a", "/lpx", "/lp-assetsx/a", "/up/a"]) {
      expect(await effective(p, "Referrer-Policy"), p).toBe("strict-origin-when-cross-origin");
    }
  });

  it("公開ページでもほかの防御ヘッダは全体の値のまま(上書きは Referrer-Policy だけ)", async () => {
    for (const p of ["/t/a", "/u/a", "/lp/a", "/lp-assets/a"]) {
      expect(await effective(p, "X-Frame-Options"), p).toBe("SAMEORIGIN");
      expect(await effective(p, "X-Content-Type-Options"), p).toBe("nosniff");
    }
    for (const r of await rules()) {
      if (r.source === "/:path*") continue;
      expect(r.headers.map((h) => h.key), r.source).toEqual(["Referrer-Policy"]);
    }
  });
});

describe("nginx 設定例: 公開の location は server の Referrer-Policy を引き継がない", () => {
  const CONF = readFileSync(path.join(process.cwd(), "deploy/nginx/property-management.conf.example"), "utf8").replace(/\r\n/g, "\n");
  const https = CONF.slice(CONF.indexOf("# HTTPS"));
  const block = (header: string) => {
    const start = https.indexOf(header);
    expect(start, `${header} が443側に無い`).toBeGreaterThan(-1);
    return https.slice(start, https.indexOf("\n    }", start));
  };
  const cases: [string, string][] = [
    ["location ^~ /u/ {", "strict-origin"],
    ["location ^~ /t/ {", "strict-origin"],
    ["location ^~ /lp-assets/ {", "strict-origin"],
    ["location ^~ /lp/ {", "strict-origin"],
    ['location ~ "^/submit/', "no-referrer"],
  ];
  for (const [header, want] of cases) {
    it(`${header} は自分の add_header で ${want} と防御ヘッダを持つ`, () => {
      const b = block(header);
      expect(b).toContain(`add_header Referrer-Policy        "${want}" always;`);
      expect(b).toContain('add_header X-Frame-Options        "SAMEORIGIN"  always;');
      expect(b).toContain('add_header X-Content-Type-Options "nosniff"     always;');
    });
  }
});
