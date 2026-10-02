import { vi } from "vitest";
vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response { static json = (b: unknown, init?: ResponseInit) => Response.json(b, init); }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error { status: number; code: string; constructor(s: number, m: string, c = "ERROR") { super(m); this.status = s; this.code = c; } }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(), getUserPermissions: vi.fn(),
    parseJsonBody: vi.fn(async (r: Request) => { const t = await r.text(); return t ? JSON.parse(t) : {}; }),
    handleApiError: vi.fn((e: unknown) => {
      if (e instanceof MockApiError) return Response.json({ error: { message: e.message, code: e.code } }, { status: e.status });
      if (e !== null && typeof e === "object" && "issues" in e && Array.isArray((e as Record<string, unknown>).issues)) {
        return Response.json({ error: { code: "VALIDATION_ERROR" } }, { status: 422 });
      }
      return Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 });
    }),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: {
    mailConfig: { findUnique: vi.fn(), upsert: vi.fn() },
    user: { findUnique: vi.fn(), count: vi.fn() },
    saleDmConfig: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/mail/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mail/transport")>();
  return { ...actual, sendPlainMail: vi.fn() };
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { sendPlainMail } from "@/lib/mail/transport";
import { encryptSecret } from "../sale-dm-letter/secret-crypto";
import { loadInquiryAutoReplySettings } from "../mail/mail-config";
import { GET, PUT } from "../../app/api/admin/mail-settings/route";
import { POST } from "../../app/api/admin/mail-settings/test/route";

const pm = prismaMock as never as {
  mailConfig: { findUnique: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };
  user: { findUnique: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> };
  saleDmConfig: { findUnique: ReturnType<typeof vi.fn> };
};
const send = sendPlainMail as ReturnType<typeof vi.fn>;
const audit = writeAuditLog as ReturnType<typeof vi.fn>;
const putReq = (b: unknown) => new Request("http://x", { method: "PUT", body: JSON.stringify(b) }) as never;
const testReq = (b?: unknown) => new Request("http://x", { method: "POST", body: b === undefined ? undefined : JSON.stringify(b) });

let savedKey: string | undefined;
const row = (overrides: Record<string, unknown> = {}) => ({
  id: "singleton",
  smtpHost: "sv1.xserver.jp",
  smtpPort: 465,
  smtpSecure: true,
  smtpUser: "info@ligarejapan.com",
  smtpPassEnc: encryptSecret("pw"),
  fromAddress: "info@ligarejapan.com",
  appBaseUrl: null,
  inquiryMailDetail: "minimal",
  inquiryAutoReplyEnabled: false,
  inquiryAutoReplySubject: null,
  inquiryAutoReplyBody: null,
  ...overrides,
});

beforeEach(() => {
  savedKey = process.env.SALE_DM_SETTINGS_ENC_KEY;
  process.env.SALE_DM_SETTINGS_ENC_KEY = crypto.randomBytes(32).toString("base64");
  vi.clearAllMocks();
  (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "admin-1", email: "admin@example.com" });
  (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue([{ resource: "user_management", action: "write", granted: true }]);
  pm.user.count.mockResolvedValue(1);
  pm.user.findUnique.mockResolvedValue({ email: "admin@example.com", inquiryNotifyEmail: null });
  pm.saleDmConfig.findUnique.mockResolvedValue({ senderName: "LigareJapan", senderContact: "03-1234-5678", trackingBaseUrl: null, privacyText: null });
  pm.mailConfig.findUnique.mockResolvedValue(row());
  pm.mailConfig.upsert.mockImplementation(async (arg: { update: Record<string, unknown> }) => row(arg.update));
  send.mockResolvedValue({ ok: true });
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.SALE_DM_SETTINGS_ENC_KEY;
  else process.env.SALE_DM_SETTINGS_ENC_KEY = savedKey;
});

describe("メール送信設定: 申込者への受付メール", () => {
  it("GET は初期OFF・文面なしと、既定の文面(差出人名・連絡先つき)を返す", async () => {
    const data = (await (await GET()).json()).data;
    expect(data.inquiryAutoReplyEnabled).toBe(false);
    expect(data.inquiryAutoReplySubject).toBeNull();
    expect(data.inquiryAutoReplyBody).toBeNull();
    expect(data.inquiryAutoReplyDefaultSubject).toBe("【LigareJapan】査定のお申し込みを受け付けました");
    expect(data.inquiryAutoReplyDefaultBody).toContain("03-1234-5678");
  });

  it("列を持たない古い行(反映の途中)でも OFF 扱いで返す", async () => {
    const old = row() as Record<string, unknown>;
    delete old.inquiryAutoReplyEnabled;
    delete old.inquiryAutoReplySubject;
    delete old.inquiryAutoReplyBody;
    pm.mailConfig.findUnique.mockResolvedValue(old);
    const data = (await (await GET()).json()).data;
    expect(data.inquiryAutoReplyEnabled).toBe(false);
    expect(data.inquiryAutoReplySubject).toBeNull();
  });

  it("PUT でスイッチ・件名・本文を保存する(本文の改行は LF に・監査は項目名だけ)", async () => {
    const res = await PUT(putReq({ inquiryAutoReplyEnabled: true, inquiryAutoReplySubject: " 受付のお知らせ ", inquiryAutoReplyBody: "1行目\r\n2行目" }));
    expect(res.status).toBe(200);
    const update = pm.mailConfig.upsert.mock.calls[0][0].update;
    expect(update.inquiryAutoReplyEnabled).toBe(true);
    expect(update.inquiryAutoReplySubject).toBe("受付のお知らせ");
    expect(update.inquiryAutoReplyBody).toBe("1行目\n2行目");
    const detail = audit.mock.calls[0][0].detail;
    expect(detail).toEqual({ fields: ["inquiryAutoReplyEnabled", "inquiryAutoReplySubject", "inquiryAutoReplyBody"] });
    expect(JSON.stringify(audit.mock.calls)).not.toContain("受付のお知らせ");
  });

  it("件名・本文を空にすると null(既定の文面に戻る)", async () => {
    await PUT(putReq({ inquiryAutoReplySubject: "", inquiryAutoReplyBody: "  \n " }));
    const update = pm.mailConfig.upsert.mock.calls[0][0].update;
    expect(update.inquiryAutoReplySubject).toBeNull();
    expect(update.inquiryAutoReplyBody).toBeNull();
  });

  it("送らなかった項目は触らない(他の設定だけの保存でスイッチが変わらない)", async () => {
    await PUT(putReq({ smtpHost: "sv2.xserver.jp" }));
    const update = pm.mailConfig.upsert.mock.calls[0][0].update;
    expect("inquiryAutoReplyEnabled" in update).toBe(false);
    expect("inquiryAutoReplySubject" in update).toBe(false);
    expect("inquiryAutoReplyBody" in update).toBe(false);
  });

  it.each([
    ["件名に改行", { inquiryAutoReplySubject: "a\nb" }],
    ["件名が長すぎる", { inquiryAutoReplySubject: "あ".repeat(121) }],
    ["本文が長すぎる", { inquiryAutoReplyBody: "あ".repeat(2001) }],
    ["本文に制御文字", { inquiryAutoReplyBody: `a${String.fromCharCode(0)}b` }],
    ["スイッチが真偽値でない", { inquiryAutoReplyEnabled: "yes" }],
  ])("%s は 422 で保存しない", async (_label, body) => {
    const res = await PUT(putReq(body));
    expect(res.status).toBe(422);
    expect(pm.mailConfig.upsert).not.toHaveBeenCalled();
  });

  it("管理者でなければ 403", async () => {
    (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue([{ resource: "user_management", action: "write", granted: false }]);
    expect((await PUT(putReq({ inquiryAutoReplyEnabled: true }))).status).toBe(403);
    expect(pm.mailConfig.upsert).not.toHaveBeenCalled();
  });

  it("loadInquiryAutoReplySettings: 行なし・DB 例外は OFF(送らない側)", async () => {
    pm.mailConfig.findUnique.mockResolvedValue(row({ inquiryAutoReplyEnabled: true, inquiryAutoReplySubject: "S", inquiryAutoReplyBody: "B" }));
    expect(await loadInquiryAutoReplySettings()).toEqual({ enabled: true, subject: "S", body: "B" });
    pm.mailConfig.findUnique.mockResolvedValue(null);
    expect(await loadInquiryAutoReplySettings()).toEqual({ enabled: false, subject: null, body: null });
    pm.mailConfig.findUnique.mockRejectedValue(new Error("db down"));
    expect(await loadInquiryAutoReplySettings()).toEqual({ enabled: false, subject: null, body: null });
  });
});

describe("テスト送信: 受付メールを自分あてに", () => {
  it("kind=auto_reply は保存済みの文面を【テスト】つきで操作者へ送る(スイッチOFFでも可)", async () => {
    pm.mailConfig.findUnique.mockResolvedValue(row({ inquiryAutoReplySubject: "受付のお知らせ", inquiryAutoReplyBody: "本文です" }));
    const res = await POST(testReq({ kind: "auto_reply" }));
    expect(res.status).toBe(200);
    expect(send.mock.calls[0][1]).toEqual({ to: "admin@example.com", subject: "【テスト】受付のお知らせ", text: "本文です" });
  });

  it("文面が未入力なら既定の文面を送る", async () => {
    await POST(testReq({ kind: "auto_reply" }));
    const mail = send.mock.calls[0][1];
    expect(mail.subject).toBe("【テスト】【LigareJapan】査定のお申し込みを受け付けました");
    expect(mail.text).toContain("担当者よりご連絡いたします");
  });

  it("本文なし・知らない kind は従来の通知メールの確認", async () => {
    await POST();
    await POST(testReq());
    await POST(testReq({ kind: "something" }));
    for (const [, mail] of send.mock.calls) expect(mail.subject).toBe("【テスト】通知メールの送信確認");
    expect(send).toHaveBeenCalledTimes(3);
  });
});
