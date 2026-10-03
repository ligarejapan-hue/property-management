/**
 * 送り先の判定(eligibility.ts)。判定そのものの失敗は「見られない」にせず投げる(@codex #472 P2)。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const checkSaleDmAccessFor = vi.fn();
vi.mock("@/lib/sale-dm-letter/route-guard", () => ({ checkSaleDmAccessFor: (...a: unknown[]) => checkSaleDmAccessFor(...a) }));
vi.mock("@/lib/api-helpers", async () => (await import("../../__tests__/agent-inquiry-route-mocks")).apiHelpersMock());
vi.mock("@/lib/prisma", () => ({ default: {} }));

import { canReceiveInquiryNotice, inquiryInScope, type Recipient } from "../deliveries/eligibility";

const R = (over: Partial<Recipient> = {}): Recipient => ({ id: "u1", role: "office_staff", inquiryNotifyEnabled: true, permissions: [], ...over });

beforeEach(() => {
  checkSaleDmAccessFor.mockReset();
});

describe("査定申込を知らせてよい人か", () => {
  it("通知 OFF なら確かめずに false", async () => {
    await expect(canReceiveInquiryNotice(R({ inquiryNotifyEnabled: false }))).resolves.toBe(false);
    expect(checkSaleDmAccessFor).not.toHaveBeenCalled();
  });
  it("申込一覧の権限の判定どおり", async () => {
    checkSaleDmAccessFor.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, reason: "permission" });
    await expect(canReceiveInquiryNotice(R())).resolves.toBe(true);
    await expect(canReceiveInquiryNotice(R())).resolves.toBe(false);
  });
  it("判定そのものが失敗したら投げる(一時的な失敗で知らせを永久に落とさない=やり直させる)", async () => {
    checkSaleDmAccessFor.mockImplementation(async () => {
      throw new Error("db down");
    });
    const err = await canReceiveInquiryNotice(R()).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toBe("db down");
  });
});

describe("申込の見える範囲(field_staff は作成か担当の物件だけ)", () => {
  it("field_staff 以外は全件・field_staff は自分の物件だけ", () => {
    expect(inquiryInScope(R(), { createdBy: "x", assignedTo: "y" })).toBe(true);
    const fs = R({ role: "field_staff" });
    expect(inquiryInScope(fs, { createdBy: "u1", assignedTo: null })).toBe(true);
    expect(inquiryInScope(fs, { createdBy: "x", assignedTo: "u1" })).toBe(true);
    expect(inquiryInScope(fs, { createdBy: "x", assignedTo: "y" })).toBe(false);
    expect(inquiryInScope(fs, null)).toBe(false);
  });
});
