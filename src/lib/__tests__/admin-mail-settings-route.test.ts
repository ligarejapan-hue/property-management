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
  },
}));
// SMTP送信は実サーバーに触れない: sendPlainMail だけモックし、safeErrorCode(許可リスト検査の純関数・
// 副作用なし)は実装をそのまま使う(route側の再検査ロジックを実物で検証するため)。
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
import { GET, PUT } from "../../app/api/admin/mail-settings/route";
import { POST } from "../../app/api/admin/mail-settings/test/route";

const pm = prismaMock as never as {
  mailConfig: { findUnique: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };
  user: { findUnique: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> };
};
const admin = () => (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue([{ resource: "user_management", action: "write", granted: true }]);
const nonAdmin = () => (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue([{ resource: "user_management", action: "write", granted: false }]);
const putReq = (b: unknown) => new Request("http://x", { method: "PUT", body: JSON.stringify(b) }) as never;
const ENV = process.env;
const MKEY = crypto.randomBytes(32).toString("base64");

const completeRow = (overrides: Record<string, unknown> = {}) => ({
  id: "singleton",
  smtpHost: "smtp.example.com",
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: "user@example.com",
  smtpPassEnc: encryptSecret("secret-pass"),
  fromAddress: "from@example.com",
  appBaseUrl: null,
  inquiryMailDetail: "minimal",
  updatedAt: new Date(),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...ENV, SALE_DM_SETTINGS_ENC_KEY: MKEY };
  (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1", email: "op@example.com" });
  pm.mailConfig.findUnique.mockResolvedValue(null);
  pm.mailConfig.upsert.mockImplementation(async (args: { update: Record<string, unknown> }) => ({
    id: "singleton", smtpHost: null, smtpPort: null, smtpSecure: true, smtpUser: null,
    smtpPassEnc: null, fromAddress: null, appBaseUrl: null, inquiryMailDetail: "minimal",
    updatedAt: new Date(), ...args.update,
  }));
  pm.user.count.mockResolvedValue(0);
  pm.user.findUnique.mockResolvedValue({ email: "op@example.com", inquiryNotifyEmail: null });
});
afterEach(() => { process.env = ENV; });

describe("GET /api/admin/mail-settings", () => {
  it("admin で 200・パスワードの暗号文/平文は返さず hasPassword のみ返す", async () => {
    admin();
    pm.mailConfig.findUnique.mockResolvedValue(completeRow({ appBaseUrl: "https://app.example.com", inquiryMailDetail: "full" }));
    pm.user.count.mockResolvedValue(3);
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.smtpHost).toBe("smtp.example.com");
    expect(json.data.hasPassword).toBe(true);
    expect(json.data.complete).toBe(true);
    expect(json.data.notifyRecipientCount).toBe(3);
    // 暗号文/平文はレスポンスに含めない。
    expect(JSON.stringify(json.data)).not.toContain("v1:");
    expect(JSON.stringify(json.data)).not.toContain("secret-pass");
    expect(json.data.smtpPassword).toBeUndefined();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
  it("設定が無い場合は complete=false・notifyRecipientCount=件数のみ返す", async () => {
    admin();
    pm.user.count.mockResolvedValue(0);
    const res = await GET();
    const json = await res.json();
    expect(json.data.complete).toBe(false);
    expect(json.data.hasPassword).toBe(false);
    expect(json.data.notifyRecipientCount).toBe(0);
  });
  it("非adminは403", async () => {
    nonAdmin();
    expect((await GET()).status).toBe(403);
  });
});

describe("PUT /api/admin/mail-settings", () => {
  it("パスワードを暗号化して保存・平文では保存せず・応答にも含めない", async () => {
    admin();
    const res = await PUT(putReq({ smtpHost: "smtp.example.com", smtpPassword: "pw" }));
    expect(res.status).toBe(200);
    const update = pm.mailConfig.upsert.mock.calls[0][0].update;
    expect(update.smtpPassEnc).toMatch(/^v1:/);
    expect(update.smtpPassEnc).not.toContain("pw");
    const json = await res.json();
    expect(JSON.stringify(json)).not.toContain("\"pw\"");
    expect(json.data.hasPassword).toBe(true);
  });
  it("パスワード空文字はクリア(smtpPassEnc: null)", async () => {
    admin();
    await PUT(putReq({ smtpPassword: "" }));
    expect(pm.mailConfig.upsert.mock.calls[0][0].update.smtpPassEnc).toBeNull();
  });
  it("パスワード未指定はキー列に触れない(部分更新で既存を消さない)", async () => {
    admin();
    await PUT(putReq({ smtpHost: "smtp.example.com" }));
    const update = pm.mailConfig.upsert.mock.calls[0][0].update;
    expect("smtpPassEnc" in update).toBe(false);
  });
  it("暗号化マスターキー未設定でパスワード保存は422 ENC_KEY_MISSING・upsertしない", async () => {
    admin();
    const saved = process.env.SALE_DM_SETTINGS_ENC_KEY;
    delete process.env.SALE_DM_SETTINGS_ENC_KEY;
    const res = await PUT(putReq({ smtpPassword: "pw" }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("ENC_KEY_MISSING");
    expect(pm.mailConfig.upsert).not.toHaveBeenCalled();
    process.env.SALE_DM_SETTINGS_ENC_KEY = saved;
  });
  it("appBaseUrl: http は422(https のみ許可)", async () => {
    admin();
    expect((await PUT(putReq({ appBaseUrl: "http://x" }))).status).toBe(422);
  });
  it("appBaseUrl: javascript: は422", async () => {
    admin();
    expect((await PUT(putReq({ appBaseUrl: "javascript:alert(1)" }))).status).toBe(422);
  });
  it("appBaseUrl: 空文字はクリア(null)として受理", async () => {
    admin();
    await PUT(putReq({ appBaseUrl: "" }));
    expect(pm.mailConfig.upsert.mock.calls[0][0].update.appBaseUrl).toBeNull();
  });
  it("appBaseUrl: https の絶対URLは受理", async () => {
    admin();
    const res = await PUT(putReq({ appBaseUrl: "https://app.example.com" }));
    expect(res.status).toBe(200);
    expect(pm.mailConfig.upsert.mock.calls[0][0].update.appBaseUrl).toBe("https://app.example.com");
  });
  it("非adminは403・保存しない", async () => {
    nonAdmin();
    const res = await PUT(putReq({ smtpHost: "x" }));
    expect(res.status).toBe(403);
    expect(pm.mailConfig.upsert).not.toHaveBeenCalled();
  });
  it("監査は変更フィールド名だけ記録・値(ホスト名・パスワード)は残さない", async () => {
    admin();
    await PUT(putReq({ smtpHost: "smtp.example.com", smtpPassword: "pw-secret" }));
    const audit = (writeAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(audit.action).toBe("mail_settings_update");
    expect(audit.detail.fields).toContain("smtpHost");
    expect(audit.detail.fields).toContain("smtpPassword");
    expect(JSON.stringify(audit.detail)).not.toContain("smtp.example.com");
    expect(JSON.stringify(audit.detail)).not.toContain("pw-secret");
  });
});

describe("POST /api/admin/mail-settings/test", () => {
  it("非adminは403・送信しない", async () => {
    nonAdmin();
    const res = await POST();
    expect(res.status).toBe(403);
    expect(sendPlainMail).not.toHaveBeenCalled();
  });
  it("設定未完成は422 MAIL_NOT_CONFIGURED・送信しない", async () => {
    admin();
    pm.mailConfig.findUnique.mockResolvedValue(null);
    const res = await POST();
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("MAIL_NOT_CONFIGURED");
    expect(sendPlainMail).not.toHaveBeenCalled();
  });
  it("設定完成・送信成功で200・宛先はinquiryNotifyEmail優先・件名固定・監査result=sent", async () => {
    admin();
    pm.mailConfig.findUnique.mockResolvedValue(completeRow());
    pm.user.findUnique.mockResolvedValue({ email: "op@example.com", inquiryNotifyEmail: "notify@example.com" });
    (sendPlainMail as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const res = await POST();
    expect(res.status).toBe(200);
    expect((await res.json()).data.result).toBe("sent");
    const call = (sendPlainMail as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].to).toBe("notify@example.com");
    expect(call[1].subject).toBe("【テスト】通知メールの送信確認");
    const audit = (writeAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(audit.action).toBe("mail_settings_test");
    expect(audit.detail).toEqual({ result: "sent" });
  });
  it("inquiryNotifyEmail未設定なら操作者のemail宛に送る", async () => {
    admin();
    pm.mailConfig.findUnique.mockResolvedValue(completeRow());
    pm.user.findUnique.mockResolvedValue({ email: "op@example.com", inquiryNotifyEmail: null });
    (sendPlainMail as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    await POST();
    expect((sendPlainMail as ReturnType<typeof vi.fn>).mock.calls[0][1].to).toBe("op@example.com");
  });
  // 発注者判断: 失敗時は許可リスト一致のSMTPコード(safeErrorCode 由来)だけ応答・監査に含める。
  // 管理者がパスワード誤り(EAUTH)/接続不可等を切り分けられるようにするため。
  it("送信失敗(許可リスト一致コード)で502・応答のsmtpCodeとaudit.detail.codeに同じコードを載せる", async () => {
    admin();
    pm.mailConfig.findUnique.mockResolvedValue(completeRow());
    (sendPlainMail as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, code: "EAUTH" });
    const res = await POST();
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error.code).toBe("MAIL_SEND_FAILED");
    expect(json.error.smtpCode).toBe("EAUTH");
    const audit = (writeAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(audit.action).toBe("mail_settings_test");
    expect(audit.detail).toEqual({ result: "failed", code: "EAUTH" });
  });
  it("送信失敗(許可リスト外のコード)は応答・auditとも null(生文字列は出さない)", async () => {
    admin();
    pm.mailConfig.findUnique.mockResolvedValue(completeRow());
    (sendPlainMail as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, code: "bad code a@b" });
    const res = await POST();
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error.smtpCode).toBeNull();
    expect(JSON.stringify(json)).not.toContain("bad code a@b");
    const audit = (writeAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(audit.detail).toEqual({ result: "failed", code: null });
    expect(JSON.stringify(audit.detail)).not.toContain("bad code a@b");
  });
  it("送信失敗(コード無し)は応答・auditともnull", async () => {
    admin();
    pm.mailConfig.findUnique.mockResolvedValue(completeRow());
    (sendPlainMail as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, code: null });
    const res = await POST();
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error.smtpCode).toBeNull();
    const audit = (writeAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(audit.detail).toEqual({ result: "failed", code: null });
  });
  it("失敗応答は生メッセージ・宛先・パスワードを含まない", async () => {
    admin();
    pm.mailConfig.findUnique.mockResolvedValue(completeRow());
    pm.user.findUnique.mockResolvedValue({ email: "op@example.com", inquiryNotifyEmail: "notify@example.com" });
    (sendPlainMail as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, code: "EAUTH" });
    const res = await POST();
    const json = await res.json();
    const s = JSON.stringify(json);
    expect(s).not.toContain("notify@example.com");
    expect(s).not.toContain("secret-pass");
    expect(s).not.toContain("Invalid login: 535 5.7.8 authentication failed");
  });
});
