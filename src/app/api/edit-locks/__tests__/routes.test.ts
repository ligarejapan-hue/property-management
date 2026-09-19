import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number; code: string;
    constructor(status: number, message: string, code = "ERROR") { super(message); this.status = status; this.code = code; }
  }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(),
    getUserPermissions: vi.fn(),
    apiResponse: vi.fn((data: unknown, status = 200) => Response.json(data as object, { status })),
    handleApiError: vi.fn((e: { status?: number; message?: string; code?: string }) =>
      Response.json({ error: { message: e?.message, code: e?.code } }, { status: e?.status ?? 500 })),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: {
    property: { findUnique: vi.fn(), findMany: vi.fn() },
    owner: { findUnique: vi.fn() },
    user: { findMany: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ $queryRaw: vi.fn().mockResolvedValue([]) })),
    $queryRaw: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock("@/lib/property-record-guard", () => ({ lockPropertyRow: vi.fn() }));
vi.mock("@/lib/edit-lock/service", () => ({
  acquireEditLock: vi.fn(),
  heartbeatEditLock: vi.fn(),
  releaseEditLock: vi.fn(),
  forceReleaseEditLock: vi.fn(),
  readEditLocks: vi.fn(),
}));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import {
  acquireEditLock,
  forceReleaseEditLock,
  heartbeatEditLock,
  releaseEditLock,
  readEditLocks,
} from "@/lib/edit-lock/service";
import { hashScreenToken } from "@/lib/edit-lock/screen-token";
import { POST as acquire } from "../acquire/route";
import { POST as forceRelease } from "../force-release/route";
import { POST as heartbeat } from "../heartbeat/route";
import { POST as release } from "../release/route";
import { POST as status } from "../status/route";

const PROP = "22222222-2222-4222-8222-222222222222";
const PROP2 = "22222222-2222-4222-8222-222222222223";
const UID = "33333333-3333-4333-8333-333333333333";
const OTHER_UID = "44444444-4444-4444-8444-444444444444";
const LOCK1 = "55555555-5555-4555-8555-555555555555";
const STALE_LOCK = "66666666-6666-4666-8666-666666666666";
const pm = prisma as unknown as {
  property: { findUnique: Mock; findMany: Mock };
  owner: { findUnique: Mock };
  user: { findMany: Mock };
};
const WRITE = [
  { resource: "property", action: "write", granted: true },
  { resource: "property", action: "read", granted: true },
  { resource: "owner", action: "write", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "owner_name", action: "full", granted: true },
];
const req = (url: string, body: unknown, token: string | null = "screen-1") =>
  new Request(url, {
    method: "POST",
    headers: token ? { "Content-Type": "application/json", "X-Edit-Screen": token } : { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as unknown as Mock).mockResolvedValue({ id: UID, role: "general" });
  (getUserPermissions as unknown as Mock).mockResolvedValue(WRITE);
  pm.property.findUnique.mockResolvedValue({ createdBy: UID, assignedTo: null, isArchived: false });
  pm.property.findMany.mockResolvedValue([]);
  pm.owner.findUnique.mockResolvedValue({ id: PROP, isArchived: false });
  pm.user.findMany.mockResolvedValue([]);
  (readEditLocks as unknown as Mock).mockResolvedValue({ dbNow: new Date(), locks: [] });
});

describe("POST /api/edit-locks/acquire", () => {
  it("取得できたら 200 と世代を返し、監査を書く", async () => {
    (acquireEditLock as unknown as Mock).mockResolvedValue({
      state: "mine", lockId: "lock-1", since: new Date("2026-09-18T10:00:00Z"), takeover: null,
    });
    const res = await acquire(req("http://localhost/api/edit-locks/acquire", { resourceType: "property", resourceId: PROP }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ state: "mine", lockId: "lock-1" });
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "edit_lock_acquire" }));
  });

  it("同じ利用者の別タブからの期限切れ横取りも takeover として記録する", async () => {
    (acquireEditLock as unknown as Mock).mockResolvedValue({
      state: "mine", lockId: "lock-3", since: new Date(),
      takeover: { previousUserId: UID, expiredBy: "idle" }, // 前の保持者は自分(別タブ)
    });
    await acquire(req("http://localhost/api/edit-locks/acquire", { resourceType: "property", resourceId: PROP }));
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "edit_lock_takeover_expired" }),
    );
  });

  it("期限切れの横取りは takeover の監査を書く", async () => {
    (acquireEditLock as unknown as Mock).mockResolvedValue({
      state: "mine", lockId: "lock-2", since: new Date(),
      takeover: { previousUserId: "other", expiredBy: "heartbeat" },
    });
    await acquire(req("http://localhost/api/edit-locks/acquire", { resourceType: "property", resourceId: PROP }));
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "edit_lock_takeover_expired", detail: expect.objectContaining({ previousUserId: "other" }) }),
    );
  });

  it("他人が持っていたら 423 と保持者の氏名を返す", async () => {
    (acquireEditLock as unknown as Mock).mockResolvedValue({
      state: "held",
      current: { id: "lock-3", userId: "other", screenTokenHash: "h", acquiredAt: new Date("2026-09-18T05:02:00Z"), heartbeatAt: new Date(), activityAt: new Date(), forceReleasedAt: null },
    });
    pm.user.findMany.mockResolvedValue([{ id: "other", name: "山田" }]);
    const res = await acquire(req("http://localhost/api/edit-locks/acquire", { resourceType: "property", resourceId: PROP }));
    expect(res.status).toBe(423);
    await expect(res.json()).resolves.toMatchObject({ code: "EDIT_LOCKED", holderName: "山田" });
  });

  it("合言葉のヘッダが無ければ 400", async () => {
    const res = await acquire(req("http://localhost/api/edit-locks/acquire", { resourceType: "property", resourceId: PROP }, null));
    expect(res.status).toBe(400);
  });

  it("アーカイブ済みの物件は 404(鍵を取らせない)", async () => {
    pm.property.findUnique.mockResolvedValue({ createdBy: UID, assignedTo: null, isArchived: true });
    const res = await acquire(req("http://localhost/api/edit-locks/acquire", { resourceType: "property", resourceId: PROP }));
    expect(res.status).toBe(404);
  });

  it("担当外のアルバイトは 403", async () => {
    (getApiSession as unknown as Mock).mockResolvedValue({ id: "other-user", role: "field_staff" });
    const res = await acquire(req("http://localhost/api/edit-locks/acquire", { resourceType: "property", resourceId: PROP }));
    expect(res.status).toBe(403);
  });
});

describe("POST /api/edit-locks/heartbeat", () => {
  const hb = (body: unknown, token: string | null = "screen-1") =>
    heartbeat(req("http://localhost/api/edit-locks/heartbeat", body, token));

  it("更新できたら 200 と state:ok", async () => {
    (heartbeatEditLock as unknown as Mock).mockResolvedValue({ ok: true });
    const res = await hb({ resourceType: "property", resourceId: PROP, active: true });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ state: "ok" });
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("合言葉のヘッダが無ければ 400", async () => {
    const res = await hb({ resourceType: "property", resourceId: PROP, active: true }, null);
    expect(res.status).toBe(400);
  });

  it("自分の行が管理者に外されていたら lost/force_released", async () => {
    (heartbeatEditLock as unknown as Mock).mockResolvedValue({
      ok: false,
      dbNow: new Date("2026-09-18T10:00:00Z"),
      current: {
        id: LOCK1, userId: UID, screenTokenHash: hashScreenToken("screen-1"),
        acquiredAt: new Date("2026-09-18T09:00:00Z"), heartbeatAt: new Date("2026-09-18T09:00:00Z"),
        activityAt: new Date("2026-09-18T09:00:00Z"), forceReleasedAt: new Date("2026-09-18T09:30:00Z"),
      },
    });
    const res = await hb({ resourceType: "property", resourceId: PROP, active: true });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ state: "lost", reason: "force_released" });
  });

  it("行が無ければ lost/expired", async () => {
    (heartbeatEditLock as unknown as Mock).mockResolvedValue({
      ok: false, dbNow: new Date(), current: null,
    });
    const res = await hb({ resourceType: "property", resourceId: PROP, active: true });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ state: "lost", reason: "expired" });
  });

  it("他人の active な鍵は taken と保持者名を返す", async () => {
    (heartbeatEditLock as unknown as Mock).mockResolvedValue({
      ok: false,
      dbNow: new Date("2026-09-18T10:00:00Z"),
      current: {
        id: LOCK1, userId: OTHER_UID, screenTokenHash: "other-hash",
        acquiredAt: new Date("2026-09-18T09:55:00Z"), heartbeatAt: new Date("2026-09-18T09:59:50Z"),
        activityAt: new Date("2026-09-18T09:59:50Z"), forceReleasedAt: null,
      },
    });
    pm.user.findMany.mockResolvedValue([{ id: OTHER_UID, name: "鈴木" }]);
    const res = await hb({ resourceType: "property", resourceId: PROP, active: true });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ state: "taken", holderName: "鈴木" });
  });

  it("担当外のアルバイトは 403(保持者名を渡さない)", async () => {
    (getApiSession as unknown as Mock).mockResolvedValue({ id: "other-user", role: "field_staff" });
    const res = await hb({ resourceType: "property", resourceId: PROP, active: true });
    expect(res.status).toBe(403);
    expect(heartbeatEditLock).not.toHaveBeenCalled();
  });
});

describe("POST /api/edit-locks/release", () => {
  it("解除できたら 200 と監査 edit_lock_release", async () => {
    (releaseEditLock as unknown as Mock).mockResolvedValue({ deleted: 1 });
    const res = await release(req("http://localhost/api/edit-locks/release", { resourceType: "property", resourceId: PROP, lockId: LOCK1 }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "edit_lock_release", targetId: LOCK1 }));
  });

  it("何も消えなくても 200(冪等)で監査は書かない", async () => {
    (releaseEditLock as unknown as Mock).mockResolvedValue({ deleted: 0 });
    const res = await release(req("http://localhost/api/edit-locks/release", { resourceType: "property", resourceId: PROP, lockId: LOCK1 }));
    expect(res.status).toBe(200);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("text/plain の beacon 本文(screenToken 込み)でも受ける", async () => {
    (releaseEditLock as unknown as Mock).mockResolvedValue({ deleted: 1 });
    const res = await release(
      new Request("http://localhost/api/edit-locks/release", {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({ resourceType: "property", resourceId: PROP, lockId: LOCK1, screenToken: "raw-token" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(releaseEditLock).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ resourceType: "property", resourceId: PROP, lockId: LOCK1, userId: UID }),
    );
  });

  it("壊れた本文でも例外を投げず 200", async () => {
    const res = await release(
      new Request("http://localhost/api/edit-locks/release", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "not json",
      }),
    );
    expect(res.status).toBe(200);
    expect(releaseEditLock).not.toHaveBeenCalled();
  });

  it("合言葉が全く無ければ何もせず 200", async () => {
    const res = await release(
      req("http://localhost/api/edit-locks/release", { resourceType: "property", resourceId: PROP, lockId: LOCK1 }, null),
    );
    expect(res.status).toBe(200);
    expect(releaseEditLock).not.toHaveBeenCalled();
  });
});

describe("POST /api/edit-locks/force-release", () => {
  const fr = (body: unknown, role = "admin") => {
    (getApiSession as unknown as Mock).mockResolvedValue({ id: UID, role });
    return forceRelease(new Request("http://localhost/api/edit-locks/force-release", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }));
  };

  // ⚠lockId は uuid として zod で検証する(グローバル制約)。ブリーフの原文にある
  //   プレースホルダ文字列("lock-1"/"stale")は uuid 形式でないため、意味(世代不一致/成功)を
  //   保ったまま実在しうる uuid に置き換える。
  it("管理者以外は 403", async () => {
    const res = await fr({ resourceType: "property", resourceId: PROP, lockId: LOCK1 }, "general");
    expect(res.status).toBe(403);
  });

  it("世代が合わなければ 409 EDIT_LOCK_CHANGED", async () => {
    (forceReleaseEditLock as unknown as Mock).mockResolvedValue(null);
    const res = await fr({ resourceType: "property", resourceId: PROP, lockId: STALE_LOCK });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: "EDIT_LOCK_CHANGED" });
  });

  it("lockId が uuid 形式でなければ service を呼ばずに拒否する(22P02 の 500 化を防ぐ)", async () => {
    const res = await fr({ resourceType: "property", resourceId: PROP, lockId: "lock-1" });
    expect(res.status).not.toBe(200);
    expect(forceReleaseEditLock).not.toHaveBeenCalled();
  });

  it("外せたら監査に前の保持者を残す", async () => {
    (forceReleaseEditLock as unknown as Mock).mockResolvedValue({ previousUserId: "victim" });
    const res = await fr({ resourceType: "property", resourceId: PROP, lockId: LOCK1 });
    expect(res.status).toBe(200);
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "edit_lock_force_release", detail: expect.objectContaining({ previousUserId: "victim" }) }),
    );
  });
});

describe("POST /api/edit-locks/status", () => {
  const st = (body: unknown, token: string | null = null) =>
    status(req("http://localhost/api/edit-locks/status", body, token));

  it("閲覧権限の無い物件は結果から除外する", async () => {
    (getApiSession as unknown as Mock).mockResolvedValue({ id: "other-user", role: "field_staff" });
    (getUserPermissions as unknown as Mock).mockResolvedValue(WRITE);
    pm.property.findMany.mockResolvedValue([{ id: PROP, createdBy: UID, assignedTo: null }]);
    const res = await st({ resources: [{ resourceType: "property", resourceId: PROP }] });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ locks: [] });
    expect(readEditLocks).toHaveBeenCalledWith(prisma, []);
  });

  it("free/mine/held_by_other を返し、lockId は一般ユーザーには含めない", async () => {
    pm.property.findMany.mockResolvedValue([
      { id: PROP, createdBy: UID, assignedTo: null },
      { id: PROP2, createdBy: UID, assignedTo: null },
    ]);
    (readEditLocks as unknown as Mock).mockResolvedValue({
      dbNow: new Date("2026-09-18T10:00:00Z"),
      locks: [
        {
          resourceType: "property", resourceId: PROP,
          id: LOCK1, userId: OTHER_UID, screenTokenHash: "x",
          acquiredAt: new Date("2026-09-18T09:00:00Z"), heartbeatAt: new Date("2026-09-18T09:59:00Z"),
          activityAt: new Date("2026-09-18T09:59:00Z"), forceReleasedAt: null,
        },
      ],
    });
    pm.user.findMany.mockResolvedValue([{ id: OTHER_UID, name: "鈴木" }]);
    const res = await st({
      resources: [
        { resourceType: "property", resourceId: PROP },
        { resourceType: "property", resourceId: PROP2 },
      ],
    });
    const json = await res.json();
    expect(json.locks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resourceId: PROP, state: "held_by_other", holderName: "鈴木" }),
        expect.objectContaining({ resourceId: PROP2, state: "free" }),
      ]),
    );
    for (const l of json.locks) {
      expect(l.lockId).toBeUndefined();
    }
  });

  it("管理者には lockId を含める", async () => {
    (getApiSession as unknown as Mock).mockResolvedValue({ id: UID, role: "admin" });
    pm.property.findMany.mockResolvedValue([{ id: PROP, createdBy: UID, assignedTo: null }]);
    (readEditLocks as unknown as Mock).mockResolvedValue({
      dbNow: new Date("2026-09-18T10:00:00Z"),
      locks: [
        {
          resourceType: "property", resourceId: PROP,
          id: LOCK1, userId: OTHER_UID, screenTokenHash: "x",
          acquiredAt: new Date("2026-09-18T09:00:00Z"), heartbeatAt: new Date("2026-09-18T09:59:00Z"),
          activityAt: new Date("2026-09-18T09:59:00Z"), forceReleasedAt: null,
        },
      ],
    });
    pm.user.findMany.mockResolvedValue([{ id: OTHER_UID, name: "鈴木" }]);
    const res = await st({ resources: [{ resourceType: "property", resourceId: PROP }] });
    const json = await res.json();
    expect(json.locks[0]).toMatchObject({ lockId: LOCK1 });
  });

  it("墓標(force_released_mine)は free として返す", async () => {
    (readEditLocks as unknown as Mock).mockResolvedValue({
      dbNow: new Date("2026-09-18T10:00:00Z"),
      locks: [
        {
          resourceType: "owner", resourceId: PROP,
          id: LOCK1, userId: UID, screenTokenHash: "",
          acquiredAt: new Date("2026-09-18T09:00:00Z"), heartbeatAt: new Date("2026-09-18T09:00:00Z"),
          activityAt: new Date("2026-09-18T09:00:00Z"), forceReleasedAt: new Date("2026-09-18T09:30:00Z"),
        },
      ],
    });
    const res = await st({ resources: [{ resourceType: "owner", resourceId: PROP }] });
    const json = await res.json();
    expect(json.locks[0]).toMatchObject({ state: "free" });
  });

  it("owner:read が無ければ所有者の資源は除外する", async () => {
    (getUserPermissions as unknown as Mock).mockResolvedValue([
      { resource: "property", action: "read", granted: true },
      { resource: "property", action: "write", granted: true },
    ]);
    const res = await st({ resources: [{ resourceType: "owner", resourceId: PROP }] });
    await expect(res.json()).resolves.toEqual({ locks: [] });
  });
});
