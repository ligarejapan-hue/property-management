import { describe, it, expect, afterEach, vi } from "vitest";
import { listUnsubscribeHeaders, sendPlainMail, setMailSenderForTest } from "@/lib/mail/transport";

const config = { host: "h", port: 465, secure: true, user: "u", pass: "p", from: "info@example.jp", appBaseUrl: null, inquiryMailDetail: "minimal" as const };
afterEach(() => setMailSenderForTest(null));

describe("配信停止のヘッダー(追客メール)", () => {
  it("https の URL なら List-Unsubscribe と One-Click を付ける", () => {
    expect(listUnsubscribeHeaders("https://pub.example.test/u/fabc.def")).toEqual({
      list: { unsubscribe: { url: "https://pub.example.test/u/fabc.def", comment: "Unsubscribe" } },
      headers: { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    });
  });

  it("無い・http・改行や山かっこ・空白を含む URL には付けない(ヘッダーの差し込みを防ぐ)", () => {
    for (const u of [undefined, "", "http://pub.example.test/u/x", "https://a.test/u/x\r\nBcc: z@z.jp", "https://a.test/u/<x>", "https://a.test/u/x y"]) {
      expect(listUnsubscribeHeaders(u)).toEqual({});
    }
  });

  it("sendPlainMail は URL を送り手へ渡す・付けないときは今までどおり3項目だけ", async () => {
    const seen = vi.fn(async () => {});
    setMailSenderForTest(seen);
    await sendPlainMail(config, { to: "a@x.jp", subject: "s", text: "t", listUnsubscribeUrl: "https://pub.example.test/u/f1.s" });
    expect((seen.mock.calls[0] as unknown[])[1]).toMatchObject({ listUnsubscribeUrl: "https://pub.example.test/u/f1.s" });
    await sendPlainMail(config, { to: "a@x.jp", subject: "s", text: "t" });
    expect((seen.mock.calls[1] as unknown[])[1]).toEqual({ to: "a@x.jp", subject: "s", text: "t" });
  });
});
