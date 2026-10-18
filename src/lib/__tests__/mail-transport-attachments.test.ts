import { describe, it, expect, afterEach, vi } from "vitest";
import { sendMailWithAttachments, setMailSenderForTest } from "@/lib/mail/transport";

const config = { host: "h", port: 465, secure: true, user: "u", pass: "p", from: "info@example.jp", appBaseUrl: null, inquiryMailDetail: "minimal" as const };
afterEach(() => setMailSenderForTest(null));

describe("添付つきの送信", () => {
  it("件名の改行を除き・添付をそのまま渡す", async () => {
    const seen = vi.fn(async () => {});
    setMailSenderForTest(seen);
    const r = await sendMailWithAttachments(config, {
      to: "a@x.jp", subject: "件名\r\nBcc: z@z.jp", text: "本文",
      attachments: [{ filename: "図面.pdf", content: Buffer.from("x"), contentType: "application/pdf" }],
    });
    expect(r).toEqual({ ok: true });
    const mail = (seen.mock.calls[0] as unknown[])[1] as { subject: string; attachments: unknown[] };
    expect(mail.subject).toBe("件名Bcc: z@z.jp");
    expect(mail.attachments).toHaveLength(1);
  });
  it("失敗は throw せず code だけ返す(メッセージは出さない)", async () => {
    setMailSenderForTest(async () => { throw Object.assign(new Error("550 secret@x.jp rejected"), { code: "EENVELOPE" }); });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await sendMailWithAttachments(config, { to: "a@x.jp", subject: "s", text: "t", attachments: [] }))
      .toEqual({ ok: false, code: "EENVELOPE" });
    expect(JSON.stringify(err.mock.calls)).not.toContain("secret@x.jp");
  });
});
