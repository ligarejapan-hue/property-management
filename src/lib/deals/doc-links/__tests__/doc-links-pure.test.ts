import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { isPublicPath } from "@/proxy";
import { DOC_FILE_MAX_BYTES, docLinkExpiresAt, docLinkExpiresOn, docLinkStateOf, isDocLinkOpen, receivedChecklistItemIds } from "../constants";
import { buildDocLinkGuidance, buildMissingDocsText } from "../guidance";
import { inspectSubmittedFile } from "../inspect-file";
import { renderSubmitMessage, renderSubmitPage, submitHeaders } from "../public-page";
import { buildDocLinkToken, buildSubmitUrl, docLinkKey, DOC_LINK_SECRET_MIN_LENGTH, DOC_LINK_TOKEN_SOURCE, newDocLinkPublicId, verifyDocLinkToken } from "../token";
import { DIRTY_JPEG, DIRTY_PNG } from "./fixtures";

const KEY = Buffer.from("k".repeat(32));

describe("トークン", () => {
  it("作ったトークンは検証を通り、publicId が返る", () => {
    const id = newDocLinkPublicId();
    expect(verifyDocLinkToken(buildDocLinkToken(id, KEY), KEY)).toBe(id);
  });
  it("長い乱数を使う(publicId 16バイト+署名32バイト)", () => {
    const t = buildDocLinkToken(newDocLinkPublicId(), KEY);
    expect(t).toMatch(new RegExp(`^${DOC_LINK_TOKEN_SOURCE}$`));
    expect(newDocLinkPublicId()).not.toBe(newDocLinkPublicId());
  });
  it("署名の違い・別の鍵・形の違いは通らない", () => {
    const id = newDocLinkPublicId();
    const t = buildDocLinkToken(id, KEY);
    expect(verifyDocLinkToken(`${t.slice(0, -1)}${t.endsWith("A") ? "B" : "A"}`, KEY)).toBeNull();
    expect(verifyDocLinkToken(t, Buffer.from("x".repeat(32)))).toBeNull();
    for (const bad of [id, `${id}.`, `${t}/`, `../${t}`, `${t}%2e`, ""]) expect(verifyDocLinkToken(bad, KEY)).toBeNull();
  });
  it("鍵が無い・短いときは null(既定の鍵で動かない)", () => {
    expect(docLinkKey(undefined)).toBeNull();
    expect(docLinkKey("")).toBeNull();
    expect(docLinkKey(" ".repeat(40))).toBeNull();
    expect(docLinkKey("a".repeat(DOC_LINK_SECRET_MIN_LENGTH - 1))).toBeNull();
    expect(docLinkKey("a".repeat(DOC_LINK_SECRET_MIN_LENGTH))).not.toBeNull();
  });
  it("公開の URL は設定の土台から作る", () => {
    expect(buildSubmitUrl("https://x.example/", "abc")).toBe("https://x.example/submit/abc");
  });
});

describe("リンクの状態", () => {
  const now = new Date("2026-11-02T00:00:00Z");
  const base = { partyRole: "seller", party: { role: "seller", isSelf: false }, revokedAt: null, expiresAt: new Date("2026-11-03T00:00:00Z"), deal: { status: "contracted" } };
  it("有効なのは期限内・無効化なし・当事者あり・取引が動いているときだけ", () => {
    expect(isDocLinkOpen(base, now)).toBe(true);
    expect(isDocLinkOpen({ ...base, expiresAt: now }, now)).toBe(false);
    expect(isDocLinkOpen({ ...base, revokedAt: now }, now)).toBe(false);
    expect(isDocLinkOpen({ ...base, party: null }, now)).toBe(false);
    expect(isDocLinkOpen({ ...base, party: { role: "seller", isSelf: true } }, now)).toBe(false);
    expect(isDocLinkOpen({ ...base, party: { role: "buyer", isSelf: false } }, now)).toBe(false);
    expect(isDocLinkOpen({ ...base, deal: { status: "cancelled" } }, now)).toBe(false);
    expect(isDocLinkOpen({ ...base, deal: { status: "settled" } }, now)).toBe(false);
  });
  it("状態の名前", () => {
    expect(docLinkStateOf(base, now)).toBe("active");
    expect(docLinkStateOf({ ...base, expiresAt: new Date("2026-11-01T00:00:00Z") }, now)).toBe("expired");
    expect(docLinkStateOf({ ...base, revokedAt: now }, now)).toBe("revoked");
    expect(docLinkStateOf({ ...base, party: null, revokedAt: now }, now)).toBe("party_changed");
    expect(docLinkStateOf({ ...base, party: { role: "buyer", isSelf: false } }, now)).toBe("party_changed");
  });
  it("期限は日本時間の日の終わりまで。文面の日付と実際に切れる時刻がそろう", () => {
    // 日本時間 11/1 10:00 に 14 日で発行 → 11/15 いっぱい使える。
    const expires = docLinkExpiresAt(new Date("2026-11-01T01:00:00Z"), 14);
    expect(expires.toISOString()).toBe("2026-11-15T15:00:00.000Z");
    expect(docLinkExpiresOn(expires)).toBe("2026-11-15");
    const open = { ...base, expiresAt: expires };
    expect(isDocLinkOpen(open, new Date("2026-11-15T14:59:59Z"))).toBe(true);
    expect(isDocLinkOpen(open, new Date("2026-11-15T15:00:00Z"))).toBe(false);
    // 日本時間の 0 時台(UTC では前の日)でも日本時間の日で数える。
    expect(docLinkExpiresOn(docLinkExpiresAt(new Date("2026-10-31T15:30:00Z"), 14))).toBe("2026-11-15");
  });
  it("画像は白で塗ってから描く(透明な部分が黒くならない)", () => {
    const html = renderSubmitPage({ companyName: "x", nonce: "N", requests: [] });
    expect(html.indexOf("fillRect")).toBeGreaterThan(-1);
    expect(html.indexOf("fillRect")).toBeLessThan(html.indexOf("drawImage"));
  });
  it("書類確認書の ✓ は、同じ項目の依頼がすべて受領のときだけ", () => {
    const ids = receivedChecklistItemIds([
      { checklistItemId: "a", status: "received" }, { checklistItemId: "a", status: "submitted" },
      { checklistItemId: "b", status: "received" }, { checklistItemId: "b", status: "received" },
      { checklistItemId: "c", status: "pending" },
    ]);
    expect([...ids]).toEqual(["b"]);
  });
});

describe("保存前の検査(サーバー側で必ず通す)", () => {
  it("JPEG は EXIF やコメントを取り除いてから返す", () => {
    expect(DIRTY_JPEG.includes(Buffer.from("Exif"))).toBe(true);
    const r = inspectSubmittedFile(DIRTY_JPEG);
    if (!r.ok) throw new Error(r.reason);
    expect(r.mimeType).toBe("image/jpeg");
    expect(r.ext).toBe("jpg");
    expect(r.buffer.includes(Buffer.from("Exif"))).toBe(false);
    expect(r.buffer.includes(Buffer.from("試験 太郎"))).toBe(false);
  });
  it("PNG のテキストも取り除く", () => {
    const r = inspectSubmittedFile(DIRTY_PNG);
    if (!r.ok) throw new Error(r.reason);
    expect(r.mimeType).toBe("image/png");
    expect(r.buffer.includes(Buffer.from("GPS"))).toBe(false);
  });
  it("PDF は種類だけ確かめて、そのまま返す", () => {
    const pdf = Buffer.from("%PDF-1.7\nbody");
    const r = inspectSubmittedFile(pdf);
    if (!r.ok) throw new Error(r.reason);
    expect(r.mimeType).toBe("application/pdf");
    expect(r.buffer.equals(pdf)).toBe(true);
  });
  it.each([
    ["HTML", Buffer.from("<html><script>alert(1)</script></html>")],
    ["SVG", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ["HEIC", Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic")])],
    ["ZIP", Buffer.from("PK\u0003\u0004xxxx")],
    ["空", Buffer.alloc(0)],
  ])("%s は断る", (_n, buf) => {
    expect(inspectSubmittedFile(buf)).toEqual({ ok: false, reason: "unsupported" });
  });
  it("大きすぎれば断る", () => {
    expect(inspectSubmittedFile(Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(DOC_FILE_MAX_BYTES)]))).toEqual({ ok: false, reason: "too_large" });
  });
  it("JPEG の頭だけで中身が壊れているものは保存しない", () => {
    expect(inspectSubmittedFile(Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]))).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("お客様のページの HTML", () => {
  const html = renderSubmitPage({
    companyName: "試験<不動産>", nonce: "NONCE",
    requests: [
      { id: "r1", label: "本人確認書類", status: "pending", fileCount: 0 },
      { id: "r2", label: "住民票", status: "submitted", fileCount: 2 },
      { id: "r3", label: "印鑑証明書", status: "received", fileCount: 1 },
      { id: "r4", label: "実印", status: "rejected", fileCount: 0 },
    ],
  });
  it("会社名・書類名・提出状況を出し、文字を無害化する", () => {
    expect(html).toContain("試験&lt;不動産&gt;");
    expect(html).toContain("本人確認書類");
    expect(html).toContain("届きました(確認中)(2点)");
    expect(html).toContain("もう一度提出してください");
  });
  it("撮影とファイル選択がある。受領した書類には出さない", () => {
    expect(html).toContain('capture="environment"');
    expect(html).toContain('accept="image/*,application/pdf"');
    expect(html.match(/capture="environment"/g)?.length).toBe(3);
  });
  it("外部の読み込みがなく、ファイルへのリンクもない", () => {
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<link\b/);
    expect(html).not.toMatch(/<img\b/);
    expect(html).not.toContain("<a ");
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).toContain('<meta name="robots" content="noindex');
  });
  it("使えないリンクの画面も外部を読まない", () => {
    expect(renderSubmitMessage("x")).not.toMatch(/https?:\/\//);
  });
  it("応答ヘッダ", () => {
    const h = submitHeaders("text/html; charset=utf-8", "N");
    expect(h["Referrer-Policy"]).toBe("no-referrer");
    expect(h["Cache-Control"]).toBe("no-store");
    expect(h["X-Robots-Tag"]).toContain("noindex");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    const csp = h["Content-Security-Policy"];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-N'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/https?:|unsafe-inline|\*/);
    expect(submitHeaders("application/json")["Content-Security-Policy"]).not.toContain("script-src");
  });
});

describe("next.config の全体ヘッダ", () => {
  it("/submit/ の Referrer-Policy は no-referrer(全体の指定のあとで上書きする)", async () => {
    const { default: config } = await import("../../../../../next.config");
    const rules = await (config.headers as () => Promise<{ source: string; headers: { key: string; value: string }[] }[]>)();
    const submit = rules.findIndex((r) => r.source === "/submit/:path*");
    expect(submit).toBeGreaterThan(rules.findIndex((r) => r.source === "/:path*"));
    expect(rules[submit].headers).toEqual([{ key: "Referrer-Policy", value: "no-referrer" }]);
  });
});

describe("再案内の文面", () => {
  const requests = [
    { label: "本人確認書類", status: "pending", rejectReason: null },
    { label: "住民票", status: "rejected", rejectReason: "文字が読めません" },
    { label: "印鑑証明書", status: "received", rejectReason: null },
    { label: "実印", status: "submitted", rejectReason: null },
  ];
  it("足りない書類=未提出と差し戻しだけ(理由つき)", () => {
    expect(buildMissingDocsText(requests)).toBe("・本人確認書類\n・住民票(再提出:文字が読めません)");
    expect(buildMissingDocsText(requests.slice(2))).toBeNull();
  });
  it("リンクと期限が入る", () => {
    const t = buildDocLinkGuidance({ partyName: "試験 太郎", companyName: "試験不動産", url: "https://x/submit/t", expiresOn: "2026-11-15", requests });
    expect(t).toContain("試験 太郎 様");
    expect(t).toContain("https://x/submit/t");
    expect(t).toContain("2026年11月15日");
    expect(t).toContain("文字が読めません");
  });
});

describe("公開の道", () => {
  it("/submit/ だけを公開にする", () => {
    expect(isPublicPath("/submit/abc")).toBe(true);
    expect(isPublicPath("/submit")).toBe(false);
    expect(isPublicPath("/submissions")).toBe(false);
    expect(isPublicPath("/api/deals/x/doc-links")).toBe(false);
  });
});

describe("nginx の見本", () => {
  const conf = readFileSync(path.join(process.cwd(), "deploy/nginx/property-management.conf.example"), "utf8").replace(/\r\n/g, "\n");
  const https = conf.slice(conf.indexOf("# HTTPS"));
  const m = /location ~ "(\^\/submit\/[^"]+)" \{([\s\S]*?)\n {4}\}\n {4}location \/submit\/ \{([\s\S]*?)\n {4}\}/.exec(https);
  if (!m) throw new Error("/submit/ の location が見本にない");
  const [, locationRe, body, fallback] = m;
  const uriCheck = /if \(\$request_uri !~ "([^"]+)"\)/.exec(body)?.[1];
  const token = buildDocLinkToken(newDocLinkPublicId(), KEY);

  it("トークンの形がアプリと同じ", () => {
    expect(locationRe).toBe(`^/submit/${DOC_LINK_TOKEN_SOURCE}(/upload)?$`);
    expect(uriCheck).toBe(`^/submit/${DOC_LINK_TOKEN_SOURCE}(/upload)?(\\?.*)?$`);
  });
  it("トークンの道と提出の道だけを通す", () => {
    const re = new RegExp(locationRe);
    expect(re.test(`/submit/${token}`)).toBe(true);
    expect(re.test(`/submit/${token}/upload`)).toBe(true);
    for (const bad of ["/submit/", "/submit/abc", `/submit/${token}/`, `/submit/${token}/other`, `/submit/${token}/upload/x`, "/api/deals", "/uploads/x", `/x/submit/${token}`]) {
      expect(re.test(bad), bad).toBe(false);
    }
  });
  it("送られたままの URL に ../ や %2e や %2f があれば通さない", () => {
    const re = new RegExp(uriCheck as string);
    expect(re.test(`/submit/${token}`)).toBe(true);
    expect(re.test(`/submit/${token}/upload`)).toBe(true);
    expect(re.test(`/submit/${token}?x=1`)).toBe(true);
    for (const bad of [
      `/api/secret/../../submit/${token}`, `/api/secret/..%2f..%2fsubmit/${token}`, `/api/secret/%2e%2e/%2e%2e/submit/${token}`,
      `/submit/${token}/../../api/x`, `/submit/${token}/%2e%2e/upload`, `/submit/${token}%2Fupload`, `/submit/%2e%2e/${token}`, `/submit//${token}`,
    ]) expect(re.test(bad), bad).toBe(false);
  });
  it("アプリへ渡すのは正規化した道だけ・ログに残さない・実 IP を渡す・本文は 10MB まで", () => {
    expect(body).toContain("proxy_pass         http://127.0.0.1:3000$uri;");
    expect(body).toContain("access_log off;");
    expect(body).toContain("error_log /dev/null crit;");
    expect(body).toContain("proxy_set_header   X-Real-IP         $remote_addr;");
    expect(body).toContain("client_max_body_size 10m;");
    expect(body).toContain("return 404;");
  });
  it("形に合わない /submit/ は 404(前方一致に ^~ を付けない=正規表現が先に効く)", () => {
    expect(fallback).toContain("return 404;");
    expect(fallback).toContain("access_log off;");
    expect(https).not.toContain("location ^~ /submit/");
  });
});
