import { describe, it, expect } from "vitest";
import { isCrossSiteOrigin } from "@/lib/public-origin";
import { PUBLIC_PAGE_HEADERS } from "@/lib/sale-dm-letter/unsubscribe-page";

const h = (init: Record<string, string>) => new Headers(init);
// 本番の再現: アプリが見る req.url は公開ホスト名にならない(前段 nginx 越し)。Host ヘッダが公開ホスト名。
const APP_URL = "http://localhost:3000/u/tok";

describe("isCrossSiteOrigin(公開の書き込み口の送信元判定)", () => {
  it("Origin なしは よそと断定しない", () => {
    expect(isCrossSiteOrigin(h({ host: "app.ligarejapan.com" }), APP_URL)).toBe(false);
  });
  it("Origin: null(no-referrer ページからのフォーム送信で実ブラウザが付ける値)は よそと断定しない", () => {
    expect(isCrossSiteOrigin(h({ host: "app.ligarejapan.com", origin: "null" }), APP_URL)).toBe(false);
  });
  it("前段越しの本番: Origin=公開ホスト名・Host=公開ホスト名 なら自分自身(req.url のホストが違っても)", () => {
    expect(isCrossSiteOrigin(h({ host: "app.ligarejapan.com", origin: "https://app.ligarejapan.com" }), APP_URL)).toBe(false);
  });
  it("大文字小文字は区別しない", () => {
    expect(isCrossSiteOrigin(h({ host: "App.LigareJapan.com", origin: "https://app.ligarejapan.com" }), APP_URL)).toBe(false);
  });
  it("よそのサイトは true", () => {
    expect(isCrossSiteOrigin(h({ host: "app.ligarejapan.com", origin: "https://evil.example" }), APP_URL)).toBe(true);
  });
  it("URL として読めない Origin は true", () => {
    expect(isCrossSiteOrigin(h({ host: "app.ligarejapan.com", origin: "::::" }), APP_URL)).toBe(true);
  });
  it("Host ヘッダが無い(テスト等で Request を直接作った)ときは req.url のホストと比べる", () => {
    expect(isCrossSiteOrigin(h({ origin: "http://app.test" }), "http://app.test/u/tok")).toBe(false);
    expect(isCrossSiteOrigin(h({ origin: "https://evil.example" }), "http://app.test/u/tok")).toBe(true);
  });
});

describe("公開ページの参照元方針", () => {
  it("same-origin(no-referrer だとフォーム送信の Origin が null になり、よそ判定が意味を失う)", () => {
    expect(PUBLIC_PAGE_HEADERS["Referrer-Policy"]).toBe("same-origin");
  });
});
