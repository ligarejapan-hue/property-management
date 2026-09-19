import { describe, it, expect, afterEach, vi } from "vitest";

// vi.mock は巻き上げられるため、参照する変数は vi.hoisted 経由で作る。
const { sendMail, createTransport } = vi.hoisted(() => {
  const sendMail = vi.fn();
  const createTransport = vi.fn(() => ({ sendMail }));
  return { sendMail, createTransport };
});
vi.mock("nodemailer", () => ({ default: { createTransport }, createTransport }));

import { sendPlainMail, setMailSenderForTest, safeErrorCode } from "@/lib/mail/transport";

const CFG = { host: "sv1.xserver.jp", port: 465, secure: true, user: "info@ligarejapan.com", pass: "pw", from: "info@ligarejapan.com", appBaseUrl: null, inquiryMailDetail: "minimal" as const };

afterEach(() => { setMailSenderForTest(null); vi.clearAllMocks(); });

describe("sendPlainMail", () => {
  it("nodemailer に1宛先・テキストのみで渡し、件名の改行は除く", async () => {
    sendMail.mockResolvedValue({});
    const r = await sendPlainMail(CFG, { to: "a@example.jp", subject: "件名\r\nBcc: x@evil", text: "本文" });
    expect(r).toEqual({ ok: true });
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ host: "sv1.xserver.jp", port: 465, secure: true, auth: { user: "info@ligarejapan.com", pass: "pw" } }));
    const arg = sendMail.mock.calls[0][0];
    expect(arg).toEqual({ from: "info@ligarejapan.com", to: "a@example.jp", subject: "件名Bcc: x@evil", text: "本文" });
    expect(arg).not.toHaveProperty("html");
    expect(arg).not.toHaveProperty("bcc");
  });
  it("失敗しても throw せず、コードだけ返す(message は出さない)", async () => {
    const err = Object.assign(new Error("535 auth failed for info@ligarejapan.com"), { code: "EAUTH" });
    sendMail.mockRejectedValue(err);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await sendPlainMail(CFG, { to: "a@example.jp", subject: "s", text: "t" });
    expect(r).toEqual({ ok: false, code: "EAUTH" });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("535");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("info@ligarejapan.com");
    spy.mockRestore();
  });
  it("STARTTLS(secure=false)は requireTLS=true で fail closed にする", async () => {
    sendMail.mockResolvedValue({});
    const cfg = { ...CFG, secure: false, port: 587 };
    await sendPlainMail(cfg, { to: "a@example.jp", subject: "s", text: "t" });
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ secure: false, requireTLS: true }));
  });
  it("SSL(secure=true)は requireTLS を要求しない", async () => {
    sendMail.mockResolvedValue({});
    await sendPlainMail(CFG, { to: "a@example.jp", subject: "s", text: "t" });
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ secure: true, requireTLS: false }));
  });
  it("差し替え口が使われる", async () => {
    const fake = vi.fn(async () => {});
    setMailSenderForTest(fake);
    await sendPlainMail(CFG, { to: "a@example.jp", subject: "s", text: "t" });
    expect(fake).toHaveBeenCalledOnce();
    expect(createTransport).not.toHaveBeenCalled();
  });
  it("safeErrorCode は大文字の定型コードだけ通す", () => {
    expect(safeErrorCode({ code: "ETIMEDOUT" })).toBe("ETIMEDOUT");
    expect(safeErrorCode({ code: "bad code a@b" })).toBeNull();
    expect(safeErrorCode(new Error("x"))).toBeNull();
    expect(typeof setMailSenderForTest).toBe("function");
  });
});
