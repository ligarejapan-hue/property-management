import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";

// 公開 /u/[token] の宛名CSVトークン(c形式)の振り分け。記録そのものは
// src/lib/dm-batch/qr-unsubscribe.ts のテストで見る(ここでは route の入口・応答・監査)。

vi.mock("next/server", () => ({ NextResponse: Response }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/property-record-guard", () => ({ lockPropertyRow: vi.fn() }));
vi.mock("@/lib/dm-batch/qr-unsubscribe", () => ({ recordBatchItemUnsubscribe: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ default: { dmRecipientDraft: { findUnique: vi.fn() } } }));

import { writeAuditLog } from "@/lib/audit";
import prisma from "@/lib/prisma";
import { recordBatchItemUnsubscribe } from "@/lib/dm-batch/qr-unsubscribe";
import { buildBatchItemUnsubscribeToken } from "@/lib/dm-batch/unsubscribe-token";
import { deriveUnsubscribeKey } from "@/lib/sale-dm-letter/unsubscribe-token";

const record = recordBatchItemUnsubscribe as ReturnType<typeof vi.fn>;
const audit = writeAuditLog as ReturnType<typeof vi.fn>;
const draftFind = (prisma as unknown as { dmRecipientDraft: { findUnique: ReturnType<typeof vi.fn> } }).dmRecipientDraft
  .findUnique;
const ITEM = "0b7e3c1a-5d2f-4a6b-9c8d-1e2f3a4b5c6d";
const ITEM2 = "1c8f4d2b-6e3a-4b7c-8d9e-2f3a4b5c6d7e";
const SECRET = "test-secret-for-batch-unsubscribe";
let saved: string | undefined;
let seq = 0;

async function post(token: string) {
  const { POST } = await import("@/app/u/[token]/route");
  seq += 1;
  const req = new Request(`http://localhost:3000/u/${token}`, {
    method: "POST",
    headers: {
      host: "app.ligarejapan.com",
      origin: "https://app.ligarejapan.com",
      "x-forwarded-for": `10.8.0.${seq}`,
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

describe("/u/ の宛名CSVトークン", () => {
  it("正しい署名なら停止を記録し、完了画面・監査は dm_batch_qr_unsubscribe(PIIなし)", async () => {
    record.mockResolvedValue({ kind: "recorded", batchId: "B1", createdLog: true });
    const token = buildBatchItemUnsubscribeToken(ITEM, deriveUnsubscribeKey(SECRET));
    const res = await post(token);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("受け付けました");
    expect(record).toHaveBeenCalledWith(ITEM);
    expect(draftFind).not.toHaveBeenCalled();
    const a = audit.mock.calls.at(-1)?.[0];
    expect(a).toMatchObject({ action: "dm_batch_qr_unsubscribe", targetTable: "dm_export_batch_items", targetId: ITEM });
    expect(Object.keys(a.detail).sort()).toEqual(["at", "batchId", "createdLog", "itemId", "result"]);
    expect(JSON.stringify(a)).not.toContain(token);
  });

  it("署名違い(別の鍵)は無効画面・記録しない", async () => {
    const token = buildBatchItemUnsubscribeToken(ITEM, crypto.randomBytes(32));
    const res = await post(token);
    expect(res.status).toBe(400);
    expect(record).not.toHaveBeenCalled();
    expect(draftFind).not.toHaveBeenCalled();
  });

  it("unsent は成功と言わない・conflict は 409・missing は完了画面", async () => {
    const token = buildBatchItemUnsubscribeToken(ITEM2, deriveUnsubscribeKey(SECRET));
    record.mockResolvedValueOnce({ kind: "unsent", batchId: "B1" });
    expect(await (await post(token)).text()).not.toContain("受け付けました");
    record.mockResolvedValueOnce({ kind: "conflict", batchId: "B1" });
    expect((await post(token)).status).toBe(409);
    record.mockResolvedValueOnce({ kind: "missing" });
    expect(await (await post(token)).text()).toContain("受け付けました");
  });

  it("GET は形だけ見て確認画面(DBに触らない)", async () => {
    const { GET } = await import("@/app/u/[token]/route");
    const token = buildBatchItemUnsubscribeToken(ITEM, deriveUnsubscribeKey(SECRET));
    const res = await GET(new Request(`http://localhost:3000/u/${token}`) as never, {
      params: Promise.resolve({ token }),
    });
    expect(res.status).toBe(200);
    expect(record).not.toHaveBeenCalled();
  });
});
