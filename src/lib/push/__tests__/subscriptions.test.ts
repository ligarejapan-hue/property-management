import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("@/lib/api-helpers", async () => (await import("../../__tests__/agent-inquiry-route-mocks")).apiHelpersMock());
vi.mock("@/lib/prisma", () => {
  const tx = {
    $queryRaw: vi.fn(async () => []),
    pushSubscription: { create: vi.fn(async () => ({})), update: vi.fn(async () => ({})) },
  };
  return {
    default: {
      __tx: tx,
      $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
      pushSubscription: { updateMany: vi.fn(async () => ({ count: 1 })), count: vi.fn(async () => 0) },
    },
  };
});

import prismaMock from "@/lib/prisma";
import { extendPushSubscription, revokePushSubscription, upsertPushSubscription, vapidPublicKey } from "../subscriptions";
import { SHARED_TTL_MS } from "../binding";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  __tx: { $queryRaw: Fn; pushSubscription: { create: Fn; update: Fn } };
  $transaction: Fn;
  pushSubscription: { updateMany: Fn; count: Fn };
};
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EP = "https://fcm.googleapis.com/fcm/send/token-xyz";
const KEYS = { p256dh: "B".repeat(87), auth: "a".repeat(22) };
const NOW = new Date("2026-10-03T03:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  pm.__tx.$queryRaw.mockResolvedValue([]);
  pm.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(pm.__tx));
});

describe("端末の登録・付け替え", () => {
  it("許可リスト外の送り先は 422(定型コード・URL を出さない)・DB に触らない", async () => {
    const err = await upsertPushSubscription(A, { endpoint: "https://evil.example/secret", ...KEYS }, NOW).catch((e) => e);
    expect(err.status).toBe(422);
    expect(err.code).toBe("endpoint_not_allowed");
    expect(JSON.stringify({ m: err.message, c: err.code })).not.toContain("secret");
    expect(pm.$transaction).not.toHaveBeenCalled();
  });
  it("鍵の形が違えば 422", async () => {
    const err = await upsertPushSubscription(A, { endpoint: EP, p256dh: "x", auth: "y" }, NOW).catch((e) => e);
    expect(err.status).toBe(422);
  });
  it("初めての端末は作る(shared・65分)。行は FOR UPDATE で押さえてから判断する", async () => {
    const r = await upsertPushSubscription(A, { endpoint: EP, ...KEYS }, NOW);
    expect((pm.__tx.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join("?")).toMatch(/FOR UPDATE/);
    expect(pm.__tx.pushSubscription.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ endpoint: EP, userId: A, deviceScope: "shared", expiresAt: new Date(NOW.getTime() + SHARED_TTL_MS), revokedAt: null }),
    });
    expect(r).toMatchObject({ deviceScope: "shared", rebound: true });
    expect(JSON.stringify(r)).not.toContain("token-xyz");
  });
  it("別の利用者の端末は付け替える(新しい結び付け・shared に戻す)", async () => {
    pm.__tx.$queryRaw.mockResolvedValue([
      { user_id: B, device_scope: "personal", binding_id: "11111111-1111-4111-8111-111111111111", bound_at: new Date("2026-09-01"), expires_at: new Date("2026-10-30"), revoked_at: null, revoked_reason: null },
    ]);
    const r = await upsertPushSubscription(A, { endpoint: EP, ...KEYS }, NOW);
    const data = pm.__tx.pushSubscription.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ userId: A, deviceScope: "shared", boundAt: NOW, revokedAt: null, revokedReason: null });
    expect(data.bindingId).not.toBe("11111111-1111-4111-8111-111111111111");
    expect(r.rebound).toBe(true);
  });
  it("中継サービスが無効と返した端末(gone)は 409 endpoint_gone", async () => {
    pm.__tx.$queryRaw.mockResolvedValue([
      { user_id: A, device_scope: "shared", binding_id: "11111111-1111-4111-8111-111111111111", bound_at: NOW, expires_at: NOW, revoked_at: NOW, revoked_reason: "gone" },
    ]);
    const err = await upsertPushSubscription(A, { endpoint: EP, ...KEYS }, NOW).catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.code).toBe("endpoint_gone");
    expect(pm.__tx.pushSubscription.update).not.toHaveBeenCalled();
  });
  it("同時の初回登録で一意制約に当たったら1回だけやり直す", async () => {
    let n = 0;
    pm.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => {
      n += 1;
      if (n === 1) throw Object.assign(new Error("unique"), { code: "P2002" });
      return fn(pm.__tx);
    });
    await expect(upsertPushSubscription(A, { endpoint: EP, ...KEYS }, NOW)).resolves.toMatchObject({ deviceScope: "shared" });
    expect(n).toBe(2);
  });
});

describe("延長・解除", () => {
  it("延長は自分の・有効な・shared の登録だけを今＋65分に", async () => {
    await extendPushSubscription(A, EP, NOW);
    expect(pm.pushSubscription.updateMany).toHaveBeenCalledWith({
      where: { endpoint: EP, userId: A, revokedAt: null, expiresAt: { gt: NOW }, deviceScope: "shared" },
      data: { expiresAt: new Date(NOW.getTime() + SHARED_TTL_MS) },
    });
  });
  it("許可リスト外の送り先では何もしない", async () => {
    await expect(extendPushSubscription(A, "https://evil.example/x", NOW)).resolves.toBe(false);
    await expect(revokePushSubscription(A, "https://evil.example/x", NOW)).resolves.toBe(false);
    expect(pm.pushSubscription.updateMany).not.toHaveBeenCalled();
  });
  it("解除は自分の登録だけを logout で無効にする", async () => {
    await revokePushSubscription(A, EP, NOW);
    expect(pm.pushSubscription.updateMany).toHaveBeenCalledWith({
      where: { endpoint: EP, userId: A, revokedAt: null },
      data: { revokedAt: NOW, revokedReason: "logout" },
    });
  });
  it("結び付けを添えた取り消しは、その結び付けのままの行だけを無効にする(次の人の登録を消さない)", async () => {
    await revokePushSubscription(A, EP, NOW, { bindingId: "11111111-1111-4111-8111-111111111111", reason: "cancelled" });
    expect(pm.pushSubscription.updateMany).toHaveBeenCalledWith({
      where: { endpoint: EP, userId: A, revokedAt: null, bindingId: "11111111-1111-4111-8111-111111111111" },
      data: { revokedAt: NOW, revokedReason: "cancelled" },
    });
  });
});

describe("VAPID の鍵", () => {
  it("3つそろわなければ使えない", () => {
    const pub = "B" + "x".repeat(86);
    expect(vapidPublicKey({ VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: "p", VAPID_SUBJECT: "mailto:a@b" } as never)).toBe(pub);
    expect(vapidPublicKey({ VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: "p" } as never)).toBeNull();
    expect(vapidPublicKey({} as never)).toBeNull();
  });
});
