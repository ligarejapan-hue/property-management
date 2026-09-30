import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => {
  const dmInquiry = { updateMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() };
  const $executeRaw = vi.fn();
  return {
    default: {
      dmInquiry,
      $executeRaw,
      // 取引の中も同じ偽物を使う(呼ばれた順番は order で確かめる)。
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ dmInquiry, $executeRaw })),
    },
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/mail/mail-config", () => ({
  loadMailSendConfig: vi.fn(),
  loadInquiryAutoReplySettings: vi.fn(),
}));
vi.mock("@/lib/mail/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mail/transport")>();
  return { ...actual, sendPlainMail: vi.fn() };
});
vi.mock("@/lib/sale-dm-letter/config-store", () => ({ loadSaleDmPublicPageConfig: vi.fn() }));

import prisma from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { loadMailSendConfig, loadInquiryAutoReplySettings } from "@/lib/mail/mail-config";
import { sendPlainMail } from "@/lib/mail/transport";
import { loadSaleDmPublicPageConfig } from "@/lib/sale-dm-letter/config-store";
import {
  AUTO_REPLY_DEDUPE_WINDOW_MS,
  sendInquiryAutoReply,
  startInquiryAutoReply,
} from "@/lib/sale-dm-letter/inquiry-auto-reply";

const pm = prisma as unknown as {
  dmInquiry: {
    updateMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
  $executeRaw: ReturnType<typeof vi.fn>;
  $transaction: ReturnType<typeof vi.fn>;
};
const audit = writeAuditLog as ReturnType<typeof vi.fn>;
const loadCfg = loadMailSendConfig as ReturnType<typeof vi.fn>;
const loadSettings = loadInquiryAutoReplySettings as ReturnType<typeof vi.fn>;
const send = sendPlainMail as ReturnType<typeof vi.fn>;
const loadSender = loadSaleDmPublicPageConfig as ReturnType<typeof vi.fn>;

const ID = "11111111-1111-4111-8111-111111111111";
const SUBMITTED = new Date("2026-09-30T03:00:00.000Z");
const CONFIG = { host: "h", port: 465, secure: true, user: "u", pass: "p", from: "info@ligarejapan.com", appBaseUrl: null, inquiryMailDetail: "minimal" };
const ON = { enabled: true, subject: null, body: null };
const OFF = { enabled: false, subject: null, body: null };

/** 取り合いの書き込み(none → sending / skipped)。 */
function claimWrites() {
  return pm.dmInquiry.updateMany.mock.calls.map(([arg]) => arg).filter((arg) => arg.where.autoReplyStatus === "none");
}
/** 終端の書き込み(sending → sent/failed/skipped)。 */
function terminalWrites() {
  return pm.dmInquiry.updateMany.mock.calls.map(([arg]) => arg).filter((arg) => arg.where.autoReplyStatus === "sending");
}

beforeEach(() => {
  vi.clearAllMocks();
  loadSettings.mockResolvedValue(ON);
  loadCfg.mockResolvedValue(CONFIG);
  loadSender.mockResolvedValue({ senderName: "LigareJapan", senderContact: "03-1234-5678" });
  pm.dmInquiry.updateMany.mockResolvedValue({ count: 1 });
  pm.dmInquiry.findUnique.mockResolvedValue({ email: "Taro@Example.com", submittedAt: SUBMITTED, autoReplyStatus: "none" });
  pm.dmInquiry.findFirst.mockResolvedValue(null);
  send.mockResolvedValue({ ok: true });
});

describe("申込者への受付メール", () => {
  it("ONでメールありなら1通送り、sent と監査を残す", async () => {
    expect(await sendInquiryAutoReply(ID)).toBe("sent");

    expect(claimWrites()).toEqual([
      { where: { id: ID, autoReplyStatus: "none", email: { not: null } }, data: { autoReplyStatus: "sending" } },
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    const [cfg, mail] = send.mock.calls[0];
    expect(cfg).toBe(CONFIG);
    expect(mail.to).toBe("Taro@Example.com");
    expect(mail.subject).toBe("【LigareJapan】査定のお申し込みを受け付けました");
    expect(mail.text).toContain("担当者よりご連絡いたします");

    expect(terminalWrites()).toEqual([
      { where: { id: ID, autoReplyStatus: "sending" }, data: { autoReplyStatus: "sent" } },
    ]);
    expect(audit).toHaveBeenCalledWith({
      action: "inquiry_auto_reply_sent",
      targetTable: "dm_inquiries",
      targetId: ID,
      detail: {},
    });
  });

  it("画面で入れた件名・本文で送る", async () => {
    loadSettings.mockResolvedValue({ enabled: true, subject: "受付のお知らせ", body: "本文" });
    await sendInquiryAutoReply(ID);
    expect(send.mock.calls[0][1]).toMatchObject({ subject: "受付のお知らせ", text: "本文" });
  });

  it("OFFなら申込の行を読みも書きもせず、何も送らない", async () => {
    loadSettings.mockResolvedValue(OFF);
    expect(await sendInquiryAutoReply(ID)).toBe("skipped");
    expect(pm.dmInquiry.findUnique).not.toHaveBeenCalled();
    expect(pm.$transaction).not.toHaveBeenCalled();
    expect(pm.dmInquiry.updateMany).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it.each([
    ["メールが書かれていない", { email: null, submittedAt: SUBMITTED, autoReplyStatus: "none" }],
    ["すでに処理済み(sent)", { email: "a@b.jp", submittedAt: SUBMITTED, autoReplyStatus: "sent" }],
    ["処理の最中(sending)", { email: "a@b.jp", submittedAt: SUBMITTED, autoReplyStatus: "sending" }],
    ["申込が無い", null],
  ])("%s なら取り合いもせず送らない", async (_label, row) => {
    pm.dmInquiry.findUnique.mockResolvedValue(row);
    expect(await sendInquiryAutoReply(ID)).toBe("skipped");
    expect(pm.$transaction).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("取り合いに負けた(同じ申込を別の処理が先に取った)なら送らない=1件につき1通", async () => {
    pm.dmInquiry.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await sendInquiryAutoReply(ID)).toBe("skipped");
    expect(send).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("取り合いは「アドレスごとの鍵 → 直近に送った申込の確認 → 印付け」を1つの取引で、この順に行う", async () => {
    await sendInquiryAutoReply(ID);
    expect(pm.$transaction).toHaveBeenCalledTimes(1);
    const lockOrder = pm.$executeRaw.mock.invocationCallOrder[0];
    const checkOrder = pm.dmInquiry.findFirst.mock.invocationCallOrder[0];
    const claimOrder = pm.dmInquiry.updateMany.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(checkOrder);
    expect(checkOrder).toBeLessThan(claimOrder);
    expect(claimOrder).toBeLessThan(send.mock.invocationCallOrder[0]);

    // 鍵はアドレスの小文字(大文字小文字違いの同じアドレスが同じ鍵になる)。
    const [strings, key] = pm.$executeRaw.mock.calls[0];
    expect(strings.join("?")).toBe("SELECT pg_advisory_xact_lock(hashtext(?)::bigint)");
    expect(key).toBe("inquiry-auto-reply:taro@example.com");
  });

  it("同じアドレスへ24時間以内に送った(送っている最中の)申込があれば、skipped の印を付けて送らない", async () => {
    pm.dmInquiry.findFirst.mockResolvedValue({ id: "other" });
    expect(await sendInquiryAutoReply(ID)).toBe("skipped");
    expect(send).not.toHaveBeenCalled();

    // 前後どちらに届いた申込でも数える(鍵の下で確かめるので、先に確かめた方が勝つ)。
    expect(pm.dmInquiry.findFirst.mock.calls[0][0].where).toEqual({
      id: { not: ID },
      email: { equals: "Taro@Example.com", mode: "insensitive" },
      autoReplyStatus: { in: ["sending", "sent"] },
      submittedAt: { gte: new Date(SUBMITTED.getTime() - AUTO_REPLY_DEDUPE_WINDOW_MS) },
    });
    expect(claimWrites()[0].data).toEqual({ autoReplyStatus: "skipped" });
    expect(terminalWrites()).toEqual([]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "inquiry_auto_reply_skipped", detail: { code: "duplicate" } }));
  });

  it("取り合った直後にOFFへ変わっていたら送らず skipped", async () => {
    loadSettings.mockResolvedValueOnce(ON).mockResolvedValueOnce(OFF);
    expect(await sendInquiryAutoReply(ID)).toBe("skipped");
    expect(send).not.toHaveBeenCalled();
    expect(terminalWrites()[0].data).toEqual({ autoReplyStatus: "skipped" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "inquiry_auto_reply_skipped", detail: { code: "disabled" } }));
  });

  it("メール送信設定が未完成なら failed(mail_not_configured)", async () => {
    loadCfg.mockResolvedValue(null);
    expect(await sendInquiryAutoReply(ID)).toBe("failed");
    expect(send).not.toHaveBeenCalled();
    expect(terminalWrites()[0].data).toEqual({ autoReplyStatus: "failed" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "inquiry_auto_reply_failed", detail: { code: "mail_not_configured" } }));
  });

  it("送信に失敗したら failed・送り直さない", async () => {
    send.mockResolvedValue({ ok: false, code: "EAUTH" });
    expect(await sendInquiryAutoReply(ID)).toBe("failed");
    expect(send).toHaveBeenCalledTimes(1);
    expect(terminalWrites()[0].data).toEqual({ autoReplyStatus: "failed" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "inquiry_auto_reply_failed", detail: { code: "EAUTH" } }));
  });

  it("SMTP のコードが許可リスト外なら send_failed に丸める(自由文を監査に入れない)", async () => {
    send.mockResolvedValue({ ok: false, code: "550 user taro@example.com unknown" });
    await sendInquiryAutoReply(ID);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ detail: { code: "send_failed" } }));
  });

  it("送る前の想定外の例外では sending のまま残さず failed にして投げ直す", async () => {
    loadSender.mockRejectedValue(new Error("db down taro@example.com"));
    await expect(sendInquiryAutoReply(ID)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(terminalWrites()[0].data).toEqual({ autoReplyStatus: "failed" });
  });

  it("⚠送信できた後の記録の失敗で failed に書き換えない(書き換えると同じアドレスへもう1通送れてしまう)", async () => {
    // 1回目=取り合い(成功)、2回目=sent の記録(失敗)。
    pm.dmInquiry.updateMany.mockResolvedValueOnce({ count: 1 }).mockRejectedValueOnce(new Error("db blip"));
    await expect(sendInquiryAutoReply(ID)).rejects.toThrow("db blip");
    expect(send).toHaveBeenCalledTimes(1);
    const writes = terminalWrites().map((w) => w.data.autoReplyStatus);
    expect(writes).toEqual(["sent"]);
  });

  it("⚠宛先アドレスを監査に出さない", async () => {
    await sendInquiryAutoReply(ID);
    send.mockResolvedValue({ ok: false, code: "EAUTH" });
    await sendInquiryAutoReply(ID);
    pm.dmInquiry.findFirst.mockResolvedValue({ id: "other" });
    await sendInquiryAutoReply(ID);
    expect(audit).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(/example\.com/i);
  });

  it("startInquiryAutoReply は待たない・投げない・ログに入力を出さない", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    loadSettings.mockRejectedValue(new Error("boom taro@example.com"));
    expect(() => startInquiryAutoReply(ID)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(err).toHaveBeenCalled();
    expect(JSON.stringify(err.mock.calls)).not.toMatch(/example\.com/);
    err.mockRestore();
  });
});
