import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// ⚠設計 §4.2: 存在・アーカイブ・担当範囲の再読み取りは**同じトランザクション(tx)**で行う
//   (行ロックが守っている状態を base client の別コネクションからは見られないため)。
//   $transaction のコールバックに渡す tx は、base client とは別の findUnique モックを持たせ、
//   「tx 側が呼ばれ、base 側は呼ばれない」ことをテストで固定できるようにする。
const txMocks = vi.hoisted(() => ({
  propertyFindUnique: vi.fn(),
  ownerFindUnique: vi.fn(),
  queryRaw: vi.fn(),
}));

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
    owner: { findUnique: vi.fn(), findMany: vi.fn() },
    user: { findMany: vi.fn() },
    // tx はロック済みの行を読む専用の findUnique を持つ(base client とは別モック)。
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
      fn({
        $queryRaw: txMocks.queryRaw,
        property: { findUnique: txMocks.propertyFindUnique },
        owner: { findUnique: txMocks.ownerFindUnique },
      }),
    ),
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
import { ApiError, getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import {
  acquireEditLock,
  forceReleaseEditLock,
  heartbeatEditLock,
  releaseEditLock,
  readEditLocks,
} from "@/lib/edit-lock/service";
import { hashScreenToken } from "@/lib/edit-lock/screen-token";
import { lockPropertyRow } from "@/lib/property-record-guard";
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
  owner: { findUnique: Mock; findMany: Mock };
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
  // heartbeat はロックしないので base client(prisma.property.findUnique)を直接読む。
  pm.property.findUnique.mockResolvedValue({ createdBy: UID, assignedTo: null, isArchived: false });
  pm.property.findMany.mockResolvedValue([]);
  pm.owner.findUnique.mockResolvedValue({ id: PROP, isArchived: false });
  // status route の存在+アーカイブ確認用(2026-09-21 外部レビュー対応)。個別テストで上書きする。
  pm.owner.findMany.mockResolvedValue([]);
  pm.user.findMany.mockResolvedValue([]);
  // acquire はロック後に**同じ tx**で読む。base client とは別モックにして混同を防ぐ。
  txMocks.propertyFindUnique.mockResolvedValue({ createdBy: UID, assignedTo: null, isArchived: false });
  txMocks.ownerFindUnique.mockResolvedValue({ id: PROP, isArchived: false });
  txMocks.queryRaw.mockResolvedValue([]);
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
    // ⚠2026-09-21 外部レビュー round2(@codex P2)対応: T1〜T2 の間に期限切れが起きた
    //   ケースは、service 側の修正後は「横取りを試みたのに takeover が記録されない
    //   まま acquire として残る」のではなく、この held の分岐に落ちる(一貫した拒否)。
    //   held のときは監査を一切書かない(edit_lock_acquire も
    //   edit_lock_takeover_expired も書かれない)ことを固定する。
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("合言葉のヘッダが無ければ 400", async () => {
    const res = await acquire(req("http://localhost/api/edit-locks/acquire", { resourceType: "property", resourceId: PROP }, null));
    expect(res.status).toBe(400);
  });

  it("アーカイブ済みの物件は 404(鍵を取らせない)", async () => {
    txMocks.propertyFindUnique.mockResolvedValue({ createdBy: UID, assignedTo: null, isArchived: true });
    const res = await acquire(req("http://localhost/api/edit-locks/acquire", { resourceType: "property", resourceId: PROP }));
    expect(res.status).toBe(404);
  });

  it("担当外のアルバイトは 403", async () => {
    (getApiSession as unknown as Mock).mockResolvedValue({ id: "other-user", role: "field_staff" });
    const res = await acquire(req("http://localhost/api/edit-locks/acquire", { resourceType: "property", resourceId: PROP }));
    expect(res.status).toBe(403);
  });

  it("存在・アーカイブの再読み取りは同じトランザクション(tx)で行う(base client では読まない)", async () => {
    (acquireEditLock as unknown as Mock).mockResolvedValue({
      state: "mine", lockId: "lock-1", since: new Date(), takeover: null,
    });
    const res = await acquire(req("http://localhost/api/edit-locks/acquire", { resourceType: "property", resourceId: PROP }));
    expect(res.status).toBe(200);
    expect(txMocks.propertyFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: PROP } }),
    );
    // base client 側の findUnique は行ロックを見られない別コネクションなので、
    // 存在・アーカイブの判定には使ってはいけない。
    expect(pm.property.findUnique).not.toHaveBeenCalled();
  });

  it("所有者も同じトランザクション(tx)で存在・アーカイブを読む", async () => {
    (acquireEditLock as unknown as Mock).mockResolvedValue({
      state: "mine", lockId: "lock-owner", since: new Date(), takeover: null,
    });
    const OWNER_ID = "77777777-7777-4777-8777-777777777777";
    const res = await acquire(req("http://localhost/api/edit-locks/acquire", { resourceType: "owner", resourceId: OWNER_ID }));
    expect(res.status).toBe(200);
    expect(txMocks.ownerFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: OWNER_ID } }),
    );
    expect(pm.owner.findUnique).not.toHaveBeenCalled();
  });

  it("所有者がアーカイブ済みなら 404", async () => {
    txMocks.ownerFindUnique.mockResolvedValue({ id: PROP, isArchived: true });
    const res = await acquire(req("http://localhost/api/edit-locks/acquire", { resourceType: "owner", resourceId: PROP }));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/edit-locks/heartbeat", () => {
  const hb = (body: unknown, token: string | null = "screen-1") =>
    heartbeat(req("http://localhost/api/edit-locks/heartbeat", body, token));

  // review Important 1(H1): 仕様 4.3 は `200 { state: "mine", idleSince }`。
  // `idleSince` は service が UPDATE と同じ文で読んだ activity_at をそのまま返す
  // (ここで new Date() を作り直さない)。
  it("更新できたら 200 と state:mine・idleSince(DBが読んだ値)", async () => {
    const idleSince = new Date("2026-09-18T09:59:30Z");
    (heartbeatEditLock as unknown as Mock).mockResolvedValue({ ok: true, idleSince });
    const res = await hb({ resourceType: "property", resourceId: PROP, active: true });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ state: "mine", idleSince: idleSince.toISOString() });
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("合言葉のヘッダが無ければ 400", async () => {
    const res = await hb({ resourceType: "property", resourceId: PROP, active: true }, null);
    expect(res.status).toBe(400);
  });

  it("自分の行が管理者に外されていたら lost/force_released(墓標の猶予=5分以内)", async () => {
    (heartbeatEditLock as unknown as Mock).mockResolvedValue({
      ok: false,
      dbNow: new Date("2026-09-18T10:00:00Z"),
      current: {
        id: LOCK1, userId: UID, screenTokenHash: hashScreenToken("screen-1"),
        acquiredAt: new Date("2026-09-18T09:00:00Z"), heartbeatAt: new Date("2026-09-18T09:00:00Z"),
        activityAt: new Date("2026-09-18T09:00:00Z"), forceReleasedAt: new Date("2026-09-18T09:59:00Z"),
      },
    });
    const res = await hb({ resourceType: "property", resourceId: PROP, active: true });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ state: "lost", reason: "force_released" });
  });

  // review Important 7(H7): 墓標にも期限(EDIT_LOCK_HEARTBEAT_GRACE_MS=5分)がある。
  // 過ぎていれば lost/force_released ではなく lost/expired として返す
  // (evaluateLock が free を返すため)。
  it("自分の行の墓標が5分を超えていたら lost/expired として扱う(H7)", async () => {
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
    await expect(res.json()).resolves.toEqual({ state: "lost", reason: "expired" });
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

  it("直前のUPDATEと本読み取りの間に生き返っていたら mine+idleSince を返す(競合)", async () => {
    const activityAt = new Date("2026-09-18T09:58:00Z");
    (heartbeatEditLock as unknown as Mock).mockResolvedValue({
      ok: false,
      dbNow: new Date("2026-09-18T10:00:00Z"),
      current: {
        id: LOCK1, userId: UID, screenTokenHash: hashScreenToken("screen-1"),
        acquiredAt: new Date("2026-09-18T09:00:00Z"), heartbeatAt: new Date("2026-09-18T09:59:55Z"),
        activityAt, forceReleasedAt: null,
      },
    });
    const res = await hb({ resourceType: "property", resourceId: PROP, active: true });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ state: "mine", idleSince: activityAt.toISOString() });
  });

  // review Important 2(M2): アーカイブ済み(または存在しない)物件は acquire と同じく
  // 404で塞ぐ。以前は isArchived のときだけ権限確認を素通りしていたため、閲覧権限の
  // 無い利用者にまで holderName が届く経路があった。
  it("アーカイブ済みの物件は 404(保持者名を渡さない・acquireと同じ)", async () => {
    pm.property.findUnique.mockResolvedValue({ createdBy: UID, assignedTo: null, isArchived: true });
    const res = await hb({ resourceType: "property", resourceId: PROP, active: true });
    expect(res.status).toBe(404);
    expect(heartbeatEditLock).not.toHaveBeenCalled();
  });

  it("存在しない物件は 404", async () => {
    pm.property.findUnique.mockResolvedValue(null);
    const res = await hb({ resourceType: "property", resourceId: PROP, active: true });
    expect(res.status).toBe(404);
    expect(heartbeatEditLock).not.toHaveBeenCalled();
  });

  // review N5: 物件側だけでなく所有者側も同じ対称性を持つことを固定する
  // (owner:write は資源に依存しないため権限漏れは無かったが、存在確認の窓口としての
  // 対称性が欠けていた=物件は404で塞ぐのに所有者は素通りしていた)。
  it("アーカイブ済みの所有者は 404(acquireと同じ)", async () => {
    pm.owner.findUnique.mockResolvedValue({ id: PROP, isArchived: true });
    const res = await hb({ resourceType: "owner", resourceId: PROP, active: true });
    expect(res.status).toBe(404);
    expect(heartbeatEditLock).not.toHaveBeenCalled();
  });

  it("存在しない所有者は 404", async () => {
    pm.owner.findUnique.mockResolvedValue(null);
    const res = await hb({ resourceType: "owner", resourceId: PROP, active: true });
    expect(res.status).toBe(404);
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

  it("セッションが無い/切れていても 200(sendBeacon はページ離脱時に飛ぶため)", async () => {
    (getApiSession as unknown as Mock).mockRejectedValue(new ApiError(401, "認証が必要です", "UNAUTHORIZED"));
    const res = await release(
      req("http://localhost/api/edit-locks/release", { resourceType: "property", resourceId: PROP, lockId: LOCK1 }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
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

  // review Important 2(H2): これは「状態」ではなく「エラー」なので、acquire の
  // held(423・裸の状態)ではなく、他のエラーと同じ封筒 `{ error: { message, code } }` を経由する。
  it("世代が合わなければ 409 EDIT_LOCK_CHANGED(エラー封筒)", async () => {
    (forceReleaseEditLock as unknown as Mock).mockResolvedValue(null);
    const res = await fr({ resourceType: "property", resourceId: PROP, lockId: STALE_LOCK });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: { message: expect.any(String), code: "EDIT_LOCK_CHANGED" },
    });
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

  // ⚠acquire で一度直した取り違え(base client vs tx)と同じ型の穴を、force-release でも
  //   固定する。lockPropertyRow / 生の FOR UPDATE は必ず「トランザクションの tx」で
  //   呼ばれる必要がある(base client に移動していても気づけるように)。
  it("物件は lockPropertyRow に tx を渡す(base client には渡さない)", async () => {
    (forceReleaseEditLock as unknown as Mock).mockResolvedValue({ previousUserId: "victim" });
    await fr({ resourceType: "property", resourceId: PROP, lockId: LOCK1 });
    expect(lockPropertyRow).toHaveBeenCalledWith(
      expect.objectContaining({ $queryRaw: txMocks.queryRaw }),
      PROP,
    );
    expect(lockPropertyRow).not.toHaveBeenCalledWith(prisma, PROP);
  });

  it("所有者は同じトランザクション(tx)の $queryRaw で行をロックする", async () => {
    (forceReleaseEditLock as unknown as Mock).mockResolvedValue({ previousUserId: "victim" });
    const OWNER_ID = "88888888-8888-4888-8888-888888888888";
    await fr({ resourceType: "owner", resourceId: OWNER_ID, lockId: LOCK1 });
    expect(txMocks.queryRaw).toHaveBeenCalled();
    // base client の $queryRaw(prisma.$queryRaw)はここでは使ってはいけない。
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
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
    pm.owner.findMany.mockResolvedValue([{ id: PROP, isArchived: false }]);
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

  // ⚠2026-09-21 外部レビュー(@codex P2・uuid大文字小文字の3件目)対応: リクエストが
  // 大文字混じりの uuid を送っても、zod 検証の時点で小文字化する。しなければ
  // Postgres が返す正規小文字表記と `propertyById`/鍵の照合キーが食い違い、
  // 保持中の鍵が free と誤報され、物件自体が結果から消えることさえあった。
  it("大文字混じりの uuid でも保持中の鍵を held_by_other として返し、物件も結果から消えない(uuid正規化)", async () => {
    const LOWER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const UPPER_ID = LOWER_ID.toUpperCase();
    pm.property.findMany.mockResolvedValue([{ id: LOWER_ID, createdBy: UID, assignedTo: null }]);
    (readEditLocks as unknown as Mock).mockResolvedValue({
      dbNow: new Date("2026-09-18T10:00:00Z"),
      locks: [
        {
          // Postgres の uuid 列は常に正規の小文字表記で返す。呼び出し元が
          // 送った大文字表記とは無関係にこの形で返ってくる。
          resourceType: "property", resourceId: LOWER_ID,
          id: LOCK1, userId: OTHER_UID, screenTokenHash: "x",
          acquiredAt: new Date("2026-09-18T09:00:00Z"), heartbeatAt: new Date("2026-09-18T09:59:00Z"),
          activityAt: new Date("2026-09-18T09:59:00Z"), forceReleasedAt: null,
        },
      ],
    });
    pm.user.findMany.mockResolvedValue([{ id: OTHER_UID, name: "鈴木" }]);
    const res = await st({ resources: [{ resourceType: "property", resourceId: UPPER_ID }] });
    expect(res.status).toBe(200);
    const json = await res.json();
    // 正規化前は propertyById のキーが一致せず、物件そのものが結果から消えていた
    // (held_by_other どころか配列が空になっていた)。
    expect(json.locks).toHaveLength(1);
    expect(json.locks[0]).toMatchObject({
      resourceId: LOWER_ID,
      state: "held_by_other",
      holderName: "鈴木",
    });
    // property.findMany には小文字化した後の id を渡す(DB の正規表記と揃える)。
    expect(pm.property.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [LOWER_ID] } } }),
    );
  });

  // ⚠2026-09-21 外部レビュー(@codex 提案・受入済): M3 は「管理者の救済路を閉じない」
  //   ためのものであって、一般利用者にアーカイブ済み資源の保持者名まで見せてよい
  //   という裁定ではなかった。一般利用者は除外・管理者は従来どおり見える、の
  //   両方向を固定する。
  describe("アーカイブ済み資源: 一般利用者は除外・管理者は救済路として見える(M3改定)", () => {
    it("一般利用者にはアーカイブ済みの物件の鍵を返さない", async () => {
      pm.property.findMany.mockResolvedValue([{ id: PROP, createdBy: UID, assignedTo: null, isArchived: true }]);
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
      const res = await st({ resources: [{ resourceType: "property", resourceId: PROP }] });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ locks: [] });
      // アーカイブ済みと分かった時点で除外するので、readEditLocks にはそもそも渡さない。
      expect(readEditLocks).toHaveBeenCalledWith(prisma, []);
    });

    it("管理者にはアーカイブ済みの物件でも鍵(lockId込み)を返す(孤児鍵の救済路)", async () => {
      (getApiSession as unknown as Mock).mockResolvedValue({ id: UID, role: "admin" });
      pm.property.findMany.mockResolvedValue([{ id: PROP, createdBy: UID, assignedTo: null, isArchived: true }]);
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
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.locks).toEqual([
        expect.objectContaining({ resourceId: PROP, state: "held_by_other", holderName: "鈴木", lockId: LOCK1 }),
      ]);
    });

    it("一般利用者にはアーカイブ済みの所有者の鍵を返さない", async () => {
      pm.owner.findMany.mockResolvedValue([{ id: PROP, isArchived: true }]);
      (readEditLocks as unknown as Mock).mockResolvedValue({
        dbNow: new Date("2026-09-18T10:00:00Z"),
        locks: [
          {
            resourceType: "owner", resourceId: PROP,
            id: LOCK1, userId: OTHER_UID, screenTokenHash: "x",
            acquiredAt: new Date("2026-09-18T09:00:00Z"), heartbeatAt: new Date("2026-09-18T09:59:00Z"),
            activityAt: new Date("2026-09-18T09:59:00Z"), forceReleasedAt: null,
          },
        ],
      });
      const res = await st({ resources: [{ resourceType: "owner", resourceId: PROP }] });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ locks: [] });
      expect(readEditLocks).toHaveBeenCalledWith(prisma, []);
    });

    it("管理者にはアーカイブ済みの所有者でも鍵(lockId込み)を返す(孤児鍵の救済路)", async () => {
      (getApiSession as unknown as Mock).mockResolvedValue({ id: UID, role: "admin" });
      pm.owner.findMany.mockResolvedValue([{ id: PROP, isArchived: true }]);
      (readEditLocks as unknown as Mock).mockResolvedValue({
        dbNow: new Date("2026-09-18T10:00:00Z"),
        locks: [
          {
            resourceType: "owner", resourceId: PROP,
            id: LOCK1, userId: OTHER_UID, screenTokenHash: "x",
            acquiredAt: new Date("2026-09-18T09:00:00Z"), heartbeatAt: new Date("2026-09-18T09:59:00Z"),
            activityAt: new Date("2026-09-18T09:59:00Z"), forceReleasedAt: null,
          },
        ],
      });
      pm.user.findMany.mockResolvedValue([{ id: OTHER_UID, name: "鈴木" }]);
      const res = await st({ resources: [{ resourceType: "owner", resourceId: PROP }] });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.locks).toEqual([
        expect.objectContaining({ resourceId: PROP, state: "held_by_other", holderName: "鈴木", lockId: LOCK1 }),
      ]);
    });

    it("存在しない所有者の鍵は一般利用者にも管理者にも返さない", async () => {
      pm.owner.findMany.mockResolvedValue([]);
      const res = await st({ resources: [{ resourceType: "owner", resourceId: PROP }] });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ locks: [] });
    });
  });
});
