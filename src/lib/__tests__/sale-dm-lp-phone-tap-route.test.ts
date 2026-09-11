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
    dmRecipientDraft: {
      findUnique: vi.fn(),
      // 既定=初回(count:1)。再訪ケースは各テストで mockResolvedValueOnce({count:0}) に差し替える。
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => ({})),
    },
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { default: db };
});

import prismaMock from "@/lib/prisma";
import { POST } from "../../app/t/[token]/phone-tap/route";
import { recordPhoneTap } from "../sale-dm-letter/phone-tap-record";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as { dmRecipientDraft: { findUnique: Fn; updateMany: Fn; update: Fn } };
const req = (ip = "10.0.0.1") =>
  new Request("http://x/t/tok/phone-tap", { method: "POST", headers: { "x-real-ip": ip } }) as never;
// Origin 付き(よそのサイトからの送信=計上しない、の検証用)。
const reqWithOrigin = (origin: string, ip = "10.0.0.1") =>
  new Request("http://x/t/tok/phone-tap", { method: "POST", headers: { "x-real-ip": ip, origin } }) as never;
const ctx = { params: Promise.resolve({ token: "tok" }) };

beforeEach(() => {
  vi.clearAllMocks();
  pm.dmRecipientDraft.findUnique.mockResolvedValue({
    id: "d1",
    propertyId: "p1",
    status: "sent",
  });
  // vi.clearAllMocks() は呼び出し履歴だけをクリアし、前のテストが仕込んだ
  // mockRejectedValue 等の差し替え実装までは消さない。毎回明示的に既定実装へ戻す
  // (先の「更新に失敗しても例外を投げない」テストの状態が後続に漏れるのを防ぐ)。
  pm.dmRecipientDraft.updateMany.mockResolvedValue({ count: 1 });
  pm.dmRecipientDraft.update.mockResolvedValue({});
});

describe("recordPhoneTap", () => {
  it("送付済みなら物件行をロックして回数+1・初回(updateMany count:1)だけ first=true", async () => {
    const r = await recordPhoneTap(prismaMock as never, "tok");
    expect(r).toEqual({ matched: true, first: true, draftId: "d1" });
    // ロック→(初回判定の)条件付きupdateMany→count++ の順(Codex指摘: 初回判定はロックの外で
    // 決めない。invocationCallOrder で3者の順序を確認する)。
    const lockOrder = lockPropertyRow.mock.invocationCallOrder[0];
    const updateManyOrder = pm.dmRecipientDraft.updateMany.mock.invocationCallOrder[0];
    const updateOrder = pm.dmRecipientDraft.update.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(updateManyOrder);
    expect(updateManyOrder).toBeLessThan(updateOrder);
    expect(pm.dmRecipientDraft.updateMany.mock.calls[0][0]).toEqual({
      where: { id: "d1", phoneTapFirstAt: null },
      data: { phoneTapFirstAt: expect.any(Date) },
    });
    expect(pm.dmRecipientDraft.update.mock.calls[0][0].data).toEqual({
      phoneTapCount: { increment: 1 },
    });

    // 再訪(2回目以降): updateMany が対象0件(既に別アクセスが埋めた)→ count:0 → first=false。
    pm.dmRecipientDraft.updateMany.mockResolvedValueOnce({ count: 0 });
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
    });
    expect(await recordPhoneTap(prismaMock as never, "tok")).toEqual({ matched: false, first: false });
    pm.dmRecipientDraft.findUnique.mockResolvedValue(null);
    expect(await recordPhoneTap(prismaMock as never, "tok")).toEqual({ matched: false, first: false });
    expect(pm.dmRecipientDraft.updateMany).not.toHaveBeenCalled();
    expect(pm.dmRecipientDraft.update).not.toHaveBeenCalled();
    expect(JSON.stringify(pm.dmRecipientDraft.update.mock.calls)).not.toContain("outcome");
  });

  it("2つの同時タップは両方 first=true にならない(updateMany の count で排他される)", async () => {
    // 1本目が先に null→date を確定させ、2本目は対象0件を引く想定(実DBでは行ロックで
    // 直列化される。ここでは mock の戻り値で「2本目は取れなかった」を再現する)。
    pm.dmRecipientDraft.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const [r1, r2] = await Promise.all([
      recordPhoneTap(prismaMock as never, "tok"),
      recordPhoneTap(prismaMock as never, "tok"),
    ]);
    const firsts = [r1, r2].filter((r) => r.matched && r.first);
    expect(firsts.length).toBe(1);
  });

  it("更新(update)に失敗しても例外を投げない", async () => {
    pm.dmRecipientDraft.update.mockRejectedValue(new Error("db"));
    expect(await recordPhoneTap(prismaMock as never, "tok")).toEqual({ matched: false, first: false });
  });

  it("初回判定の updateMany に失敗しても例外を投げない", async () => {
    pm.dmRecipientDraft.updateMany.mockRejectedValue(new Error("db"));
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

  it("未知 token も 204(存在を漏らさない)・計上も監査もしない", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue(null);
    expect((await POST(req("10.0.0.2"), ctx)).status).toBe(204);
    expect(pm.dmRecipientDraft.update).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("よそのサイトからの送信(Origin 不一致)は 204 のまま計上しない", async () => {
    const res = await POST(reqWithOrigin("https://evil.example.com", "10.0.1.1"), ctx);
    // 応答は正常時とまったく同じ(弾いたことを応答で悟らせない)。
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(pm.dmRecipientDraft.update).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("URL として読めない Origin も計上しない", async () => {
    const res = await POST(reqWithOrigin("null", "10.0.1.2"), ctx);
    expect(res.status).toBe(204);
    expect(pm.dmRecipientDraft.update).not.toHaveBeenCalled();
  });

  it("Origin が自分自身なら従来どおり計上する", async () => {
    const res = await POST(reqWithOrigin("http://x", "10.0.1.3"), ctx);
    expect(res.status).toBe(204);
    expect(pm.dmRecipientDraft.update).toHaveBeenCalledOnce();
    expect(writeAuditLog).toHaveBeenCalledOnce();
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
