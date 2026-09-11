import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => {
  class R extends Request {}
  class S extends Response {
    static json = (b: unknown, i?: ResponseInit) => Response.json(b, i);
  }
  return { NextRequest: R, NextResponse: S };
});

const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));

const { lockPropertyRow } = vi.hoisted(() => ({ lockPropertyRow: vi.fn(async () => undefined) }));
vi.mock("@/lib/property-record-guard", () => ({ lockPropertyRow }));

vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    dmRecipientDraft: { findUnique: vi.fn(), update: vi.fn(async () => ({})) },
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { default: db };
});

import prismaMock from "@/lib/prisma";
import { POST } from "../../app/t/[token]/phone-tap/route";
import { recordPhoneTap } from "../sale-dm-letter/phone-tap-record";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as { dmRecipientDraft: { findUnique: Fn; update: Fn } };
const req = (ip = "10.0.0.1") =>
  new Request("http://x/t/tok/phone-tap", { method: "POST", headers: { "x-real-ip": ip } }) as never;
const ctx = { params: Promise.resolve({ token: "tok" }) };

beforeEach(() => {
  vi.clearAllMocks();
  pm.dmRecipientDraft.findUnique.mockResolvedValue({
    id: "d1",
    propertyId: "p1",
    status: "sent",
    phoneTapFirstAt: null,
  });
  // vi.clearAllMocks() は呼び出し履歴だけをクリアし、前のテストが仕込んだ
  // mockRejectedValue 等の差し替え実装までは消さない。毎回明示的に既定実装へ戻す
  // (先の「更新に失敗しても例外を投げない」テストの状態が後続に漏れるのを防ぐ)。
  pm.dmRecipientDraft.update.mockResolvedValue({});
});

describe("recordPhoneTap", () => {
  it("送付済みなら物件行をロックして回数+1・初回だけ phoneTapFirstAt", async () => {
    const r = await recordPhoneTap(prismaMock as never, "tok");
    expect(r).toEqual({ matched: true, first: true, draftId: "d1" });
    expect(lockPropertyRow.mock.invocationCallOrder[0]).toBeLessThan(
      pm.dmRecipientDraft.update.mock.invocationCallOrder[0],
    );
    expect(pm.dmRecipientDraft.update.mock.calls[0][0].data).toEqual({
      phoneTapCount: { increment: 1 },
      phoneTapFirstAt: expect.any(Date),
    });
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      id: "d1",
      propertyId: "p1",
      status: "sent",
      phoneTapFirstAt: new Date(),
    });
    expect(await recordPhoneTap(prismaMock as never, "tok")).toEqual({
      matched: true,
      first: false,
      draftId: "d1",
    });
    expect(pm.dmRecipientDraft.update.mock.calls[1][0].data).toEqual({
      phoneTapCount: { increment: 1 },
    });
  });

  it("送付前・未知 token は数えない・反響は立てない", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      id: "d1",
      propertyId: "p1",
      status: "confirmed",
      phoneTapFirstAt: null,
    });
    expect(await recordPhoneTap(prismaMock as never, "tok")).toEqual({ matched: false, first: false });
    pm.dmRecipientDraft.findUnique.mockResolvedValue(null);
    expect(await recordPhoneTap(prismaMock as never, "tok")).toEqual({ matched: false, first: false });
    expect(pm.dmRecipientDraft.update).not.toHaveBeenCalled();
    expect(JSON.stringify(pm.dmRecipientDraft.update.mock.calls)).not.toContain("outcome");
  });

  it("更新に失敗しても例外を投げない", async () => {
    pm.dmRecipientDraft.update.mockRejectedValue(new Error("db"));
    expect(await recordPhoneTap(prismaMock as never, "tok")).toEqual({ matched: false, first: false });
  });

  it("検索(findUnique)に失敗しても例外を投げない", async () => {
    pm.dmRecipientDraft.findUnique.mockRejectedValue(new Error("db"));
    expect(await recordPhoneTap(prismaMock as never, "tok")).toEqual({ matched: false, first: false });
  });
});

describe("POST /t/[token]/phone-tap", () => {
  it("常に 204(初回は監査 sale_dm_lp_phone_tap に at だけ)", async () => {
    const res = await POST(req(), ctx);
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(writeAuditLog.mock.calls[0][0]).toMatchObject({
      action: "sale_dm_lp_phone_tap",
      targetTable: "dm_recipient_drafts",
      targetId: "d1",
    });
    expect(Object.keys(writeAuditLog.mock.calls[0][0].detail)).toEqual(["at"]);
  });

  it("未知 token も 204(存在を漏らさない)・2回目は監査なし", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue(null);
    expect((await POST(req("10.0.0.2"), ctx)).status).toBe(204);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("recordPhoneTap が想定外に例外を投げても 204/no-store・監査なし", async () => {
    pm.dmRecipientDraft.findUnique.mockRejectedValue(new Error("db"));
    const res = await POST(req("10.0.0.3"), ctx);
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("同じ端末から1分に60回を超えると黙って 204(計数しない)", async () => {
    let last: Awaited<ReturnType<typeof POST>> | undefined;
    for (let i = 0; i < 61; i++) last = await POST(req("10.9.9.9"), ctx);
    expect(pm.dmRecipientDraft.update.mock.calls.length).toBe(60);
    expect(last?.status).toBe(204);
    expect(last?.headers.get("cache-control")).toBe("no-store");
  });
});
