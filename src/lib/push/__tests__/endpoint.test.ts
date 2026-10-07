import { describe, it, expect } from "vitest";
import { checkPushEndpoint } from "../endpoint";

describe("プッシュの送り先の確認(設計書 §7.2)", () => {
  it("承認済みの4社だけ通す", () => {
    expect(checkPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toMatchObject({ ok: true, provider: "google" });
    expect(checkPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/abc")).toMatchObject({ ok: true, provider: "mozilla" });
    expect(checkPushEndpoint("https://web.push.apple.com/QOabc")).toMatchObject({ ok: true, provider: "apple" });
    expect(checkPushEndpoint("https://wns2-par02p.notify.windows.com/w/?token=abc")).toMatchObject({ ok: true, provider: "microsoft" });
  });
  it("大文字のホストも同じに扱う", () => {
    expect(checkPushEndpoint("https://FCM.googleapis.com/fcm/send/abc")).toMatchObject({ ok: true });
  });
  it("後方一致はサブドメインだけ(似せたドメイン・本体そのものは不可)", () => {
    for (const u of [
      "https://evilpush.apple.com/x",
      "https://push.apple.com/x",
      "https://web.push.apple.com.attacker.example/x",
      "https://notify.windows.com/x",
      "https://xnotify.windows.com/x",
      "https://fcm.googleapis.com.evil.example/x",
      "https://googleapis.com/x",
    ]) {
      expect(checkPushEndpoint(u), u).toEqual({ ok: false, code: "endpoint_not_allowed" });
    }
  });
  it("https 以外・ポート指定・利用者名付き・IP 直書き・localhost は不可", () => {
    for (const u of [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com:8443/fcm/send/abc",
      "https://user:pass@fcm.googleapis.com/fcm/send/abc",
      "https://127.0.0.1/x",
      "https://[::1]/x",
      "https://localhost/x",
      "https://169.254.169.254/latest",
    ]) {
      expect(checkPushEndpoint(u), u).toEqual({ ok: false, code: "endpoint_not_allowed" });
    }
  });
  it("URL でない・長すぎる・文字列でないものは endpoint_invalid", () => {
    expect(checkPushEndpoint("not a url")).toEqual({ ok: false, code: "endpoint_invalid" });
    expect(checkPushEndpoint("https://fcm.googleapis.com/" + "a".repeat(1100))).toEqual({ ok: false, code: "endpoint_invalid" });
    expect(checkPushEndpoint(null)).toEqual({ ok: false, code: "endpoint_invalid" });
  });
  it("結果に URL 本体を含めない(ログに出しても漏れない)", () => {
    const r = checkPushEndpoint("https://evil.example/secret-token");
    expect(JSON.stringify(r)).not.toContain("secret-token");
  });
});
