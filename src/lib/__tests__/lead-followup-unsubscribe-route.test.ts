import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";

// 公開 /u/[token] の追客メールのトークン(f形式)の振り分け。記録そのものは
// src/lib/lead-followup/__tests__/unsubscribe-record.test.ts で見る(ここでは入口・応答・監査)。

vi.mock("next/server", () => ({ NextResponse: Response }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/property-record-guard", () => ({ lockPropertyRow: vi.fn() }));
vi.mock("@/lib/dm-batch/qr-unsubscribe", () => ({ recordBatchItemUnsubscribe: vi.fn() }));
vi.mock("@/lib/lead-followup/unsubscribe-record", () => ({ recordFollowupUnsubscribe: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ default: { dmRecipientDraft: { findUnique: vi.fn() } } }));

import { writeAuditLog } from "@/lib/audit";
import prisma from "@/lib/prisma";
import { recordBatchItemUnsubscribe } from "@/lib/dm-batch/qr-unsubscribe";
import { recordFollowupUnsubscribe } from "@/lib/lead-followup/unsubscribe-record";
import { buildFollowupUnsubscribeToken } from "@/lib/lead-followup/unsubscribe-token";
import { deriveUnsubscribeKey } from "@/lib/sale-dm-letter/unsubscribe-token";

const record = recordFollowupUnsubscribe as ReturnType<typeof vi.fn>;
const batchRecord = recordBatchItemUnsubscribe as ReturnType<typeof vi.fn>;
const audit = writeAuditLog as ReturnType<typeof vi.fn>;
const draftFind = (prisma as unknown as { dmRecipientDraft: { findUnique: ReturnType<typeof vi.fn> } }).dmRecipientDraft
  .findUnique;
const ID = "2d9a5e3c-7f4b-4c8d-9e0f-3a4b5c6d7e8f";
const ID2 = "3eab6f4d-8a5c-4d9e-8f01-4b5c6d7e8f90";
const SECRET = "test-secret-for-followup-unsubscribe";
let saved: string | undefined;
let seq = 0;

async function post(token: string) {
  const { POST } = await import("@/app/u/[token]/route");
  seq += 1;
  const req = new Request(`http://localhost:3000/u/${token}`, {
    method: "POST",
    headers: {
      host: "app.example.test",
      origin: "https://app.example.test",
      "x-forwarded-for": `10.9.0.${seq}`,
    },
  });
  return POST(req as never, { params: Promise.resolve({ token }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  saved = process.env.NEXTAUTH_SECRET;
  process.env.NEXTAUTH_SECRET = SECRET;
});
afterEach(() => {
  if (saved === undefined) delete process.env.NEXTAUTH_SECRET;
  else process.env.NEXTAUTH_SECRET = saved;
});

describe("/u/ の追客メールのトークン", () => {
  it("正しい署名なら停止を記録し、メールの文言の完了画面・監査は種類と数だけ(アドレス・トークンなし)", async () => {
    record.mockResolvedValue({ kind: "recorded", stopped: 1 });
    const token = buildFollowupUnsubscribeToken(ID, deriveUnsubscribeKey(SECRET));
    const res = await post(token);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("受け付けました");
    expect(text).toContain("ご案内メール");
    expect(text).not.toContain("郵送");
    expect(record).toHaveBeenCalledWith(ID);
    expect(draftFind).not.toHaveBeenCalled();
    expect(batchRecord).not.toHaveBeenCalled();
    const a = audit.mock.calls.at(-1)?.[0];
    expect(a).toMatchObject({ action: "lead_followup_unsubscribe", targetTable: "lead_followups", targetId: ID });
    expect(a.detail).toEqual({ result: "recorded", stopped: 1 });
    expect(JSON.stringify(a)).not.toContain(token);
  });

  it("すでに停止済み・行が無い も同じ完了画面(在否を答えない)", async () => {
    const token = buildFollowupUnsubscribeToken(ID2, deriveUnsubscribeKey(SECRET));
    record.mockResolvedValueOnce({ kind: "already", stopped: 0 });
    const r1 = await post(token);
    record.mockResolvedValueOnce({ kind: "missing" });
    const r2 = await post(token);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(await r1.text()).toBe(await r2.text());
    expect(audit.mock.calls.at(-1)?.[0].detail).toEqual({ result: "missing" });
  });

  it("署名違い(別の鍵)は無効画面・記録しない・手紙の処理にも入らない", async () => {
    const token = buildFollowupUnsubscribeToken(ID, crypto.randomBytes(32));
    const res = await post(token);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("メールの末尾");
    expect(record).not.toHaveBeenCalled();
    expect(draftFind).not.toHaveBeenCalled();
  });

  it("よそのサイトからの送信は断る", async () => {
    const { POST } = await import("@/app/u/[token]/route");
    const token = buildFollowupUnsubscribeToken(ID, deriveUnsubscribeKey(SECRET));
    const req = new Request(`http://localhost:3000/u/${token}`, {
      method: "POST",
      headers: { host: "app.example.test", origin: "https://evil.example", "x-forwarded-for": "10.9.9.9" },
    });
    const res = await POST(req as never, { params: Promise.resolve({ token }) });
    expect(res.status).toBe(403);
    expect(record).not.toHaveBeenCalled();
  });

  it("GET は形だけ見て、メールの文言の確認画面(DB・記録に触らない)", async () => {
    const { GET } = await import("@/app/u/[token]/route");
    const token = buildFollowupUnsubscribeToken(ID, deriveUnsubscribeKey(SECRET));
    const res = await GET(new Request(`http://localhost:3000/u/${token}`) as never, {
      params: Promise.resolve({ token }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("メール配信停止のお手続き");
    expect(text).toContain('<form method="post">');
    expect(text).not.toContain(token);
    expect(record).not.toHaveBeenCalled();
    expect(draftFind).not.toHaveBeenCalled();
  });
});
