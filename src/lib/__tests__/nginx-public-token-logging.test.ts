import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// @codex PR#434 P1是正のピン: `/t/<token>` は査定申込フォームを送信できる権限そのもので、
// `/lp-assets/<publicId>` は Referrer-Policy: same-origin により Referer ヘッダに
// `/t/<token>` を載せて運ぶ。nginx の設定例でこの2つの location が access_log off に
// なっていないと、本番のアクセスログにトークンが残ってしまう(docs/deploy.md 参照)。

const read = (p: string) =>
  readFileSync(path.join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

const CONF = read("deploy/nginx/property-management.conf.example");

// HTTPS(443)側の server ブロックだけを対象にする(80番側は301転送のみで
// proxy_set_header を持たないため)。
const httpsServerBlock = CONF.slice(CONF.indexOf("# HTTPS"));

const extractBlock = (locationHeader: string) => {
  const start = httpsServerBlock.indexOf(locationHeader);
  expect(start, `${locationHeader} が443側の設定例に見つからない`).toBeGreaterThan(
    -1,
  );
  // ヘッダ直後の "{" から対応する "}" までを雑に取り出す(ネストしたブロックを含まない前提)。
  const braceStart = httpsServerBlock.indexOf("{", start);
  const braceEnd = httpsServerBlock.indexOf("\n    }", braceStart);
  expect(braceEnd, `${locationHeader} の閉じ括弧が見つからない`).toBeGreaterThan(
    -1,
  );
  return httpsServerBlock.slice(start, braceEnd);
};

describe("nginx設定例: 公開トークンを運ぶ location のアクセスログ除外(@codex PR#434 P1)", () => {
  it("location ^~ /t/ が443側に存在し access_log off; を含む", () => {
    const blocks = [...CONF.matchAll(/location \^~ \/t\/ \{[\s\S]*?\n {4}\}/g)];
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    for (const block of blocks) {
      expect(block[0]).toContain("access_log off;");
      expect(block[0]).toContain("error_log /dev/null crit;");
    }
  });

  it("location ^~ /lp-assets/ が443側に存在し access_log off; を含む", () => {
    const blocks = [
      ...CONF.matchAll(/location \^~ \/lp-assets\/ \{[\s\S]*?\n {4}\}/g),
    ];
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    for (const block of blocks) {
      expect(block[0]).toContain("access_log off;");
      expect(block[0]).toContain("error_log /dev/null crit;");
    }
  });

  it("443側の /t/ ブロックは /u/ と同じ proxy_set_header 群を持つ(Host/X-Real-IP/X-Forwarded-For/X-Forwarded-Proto)", () => {
    const block = extractBlock("location ^~ /t/ {\n        access_log off;");
    expect(block).toContain("proxy_set_header   Host              $host;");
    expect(block).toContain(
      "proxy_set_header   X-Real-IP         $remote_addr;",
    );
    expect(block).toContain(
      "proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;",
    );
    expect(block).toContain(
      "proxy_set_header   X-Forwarded-Proto $scheme;",
    );
  });

  it("443側の /lp-assets/ ブロックも同じ proxy_set_header 群を持つ", () => {
    const block = extractBlock(
      "location ^~ /lp-assets/ {\n        access_log off;",
    );
    expect(block).toContain("proxy_set_header   Host              $host;");
    expect(block).toContain(
      "proxy_set_header   X-Real-IP         $remote_addr;",
    );
    expect(block).toContain(
      "proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;",
    );
    expect(block).toContain(
      "proxy_set_header   X-Forwarded-Proto $scheme;",
    );
  });

  it("80番(HTTP)側にも /t/ と /lp-assets/ の access_log off な転送 location がある", () => {
    const httpServerBlock = CONF.slice(0, CONF.indexOf("# HTTPS"));
    expect(httpServerBlock).toMatch(
      /location \^~ \/t\/ \{\s*access_log off;\s*error_log \/dev\/null crit;\s*return 301/,
    );
    expect(httpServerBlock).toMatch(
      /location \^~ \/lp-assets\/ \{\s*access_log off;\s*error_log \/dev\/null crit;\s*return 301/,
    );
  });

  it("docs/deploy.mdは「/t/ は追加しない」という古い方針を書いていない(是正済み)", () => {
    const DEPLOY = read("docs/deploy.md");
    expect(DEPLOY).not.toMatch(/`\/t\/`\s*は追加しない/);
    expect(DEPLOY).toContain("access_log off");
    expect(DEPLOY).toContain("/lp-assets/");
  });
});
