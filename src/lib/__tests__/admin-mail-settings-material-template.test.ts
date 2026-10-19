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
import { GET, PUT } from "../../app/api/admin/mail-settings/route";

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

describe("メール送信設定: 資料送付メールのひな形", () => {
  it("GET は未登録(null)と既定の文面を返す", async () => {
    const data = (await (await GET()).json()).data;
    expect(data.materialSendSubject).toBeNull();
    expect(data.materialSendBody).toBeNull();
    expect(data.materialSendDefaultSubject).toBe("【資料送付】{物件名}");
    expect(data.materialSendDefaultBody).toContain("{担当者名} 様");
  });

  it("PUT で件名・本文を保存する(本文の改行は LF に・監査は項目名だけ)", async () => {
    const res = await PUT(putReq({ materialSendSubject: " 【資料】{物件名} ", materialSendBody: "1行目\r\n{自分の名前}" }));
    expect(res.status).toBe(200);
    const update = pm.mailConfig.upsert.mock.calls[0][0].update;
    expect(update.materialSendSubject).toBe("【資料】{物件名}");
    expect(update.materialSendBody).toBe("1行目\n{自分の名前}");
    expect(audit.mock.calls[0][0].detail).toEqual({ fields: ["materialSendSubject", "materialSendBody"] });
    expect(JSON.stringify(audit.mock.calls)).not.toContain("【資料】");
  });

  it("空にすると null(既定の文面に戻る)", async () => {
    await PUT(putReq({ materialSendSubject: "", materialSendBody: "  \n " }));
    const update = pm.mailConfig.upsert.mock.calls[0][0].update;
    expect(update.materialSendSubject).toBeNull();
    expect(update.materialSendBody).toBeNull();
  });

  it("送らなかったら触らない", async () => {
    await PUT(putReq({ smtpHost: "sv2.xserver.jp" }));
    const update = pm.mailConfig.upsert.mock.calls[0][0].update;
    expect("materialSendSubject" in update).toBe(false);
    expect("materialSendBody" in update).toBe(false);
  });

  it.each([
    ["件名に改行", { materialSendSubject: "a\nb" }],
    ["件名が長すぎる", { materialSendSubject: "あ".repeat(201) }],
    ["本文が長すぎる", { materialSendBody: "あ".repeat(10001) }],
    ["本文に制御文字", { materialSendBody: "a\u0007b" }],
  ])("%s は 422", async (_n, b) => {
    expect((await PUT(putReq(b))).status).toBe(422);
  });
});
