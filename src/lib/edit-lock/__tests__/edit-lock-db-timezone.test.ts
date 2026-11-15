/**
 * 編集の鍵の時刻を、本物の DB と本物の接続部品(@prisma/adapter-pg)で確かめる(2026-11-16 実機確認317)。
 *
 * ⚠`PUSH_DB_TEST_URL`(全 migration を流した使い捨ての DB)があるときだけ動く。中身(edit_locks・テスト用の利用者)は消す。
 *   `PUSH_DB_TEST_URL=<DB> npx vitest run --no-file-parallelism <このファイル>`
 *
 * なぜ要るか: adapter-pg は時間帯つきの時刻(timestamptz)の文字列から「+09」を**切り落として UTC とみなす**
 *   (node_modules/@prisma/adapter-pg の normalize_timestamptz)。本番の DB 接続は日本時間なので、
 *   `"acquired_at"::timestamptz` で返しても9時間先の瞬間として読まれ、帯が「(12:33〜)」と出ていた。
 *   作り物の DB(queryRaw の mock)ではこの部品を通らないので見逃した。接続の時間帯を日本時間・UTC の両方で確かめる。
 */
import { describe, it, expect, afterAll, vi } from "vitest";

// api-helpers は next-auth(next/server)を引き込み node から解決できないので、ApiError だけの作り物にする。
vi.mock("@/lib/api-helpers", () => {
  class ApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return { ApiError };
});

import { randomUUID } from "crypto";
import { PrismaClient } from "@/generated/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import { acquireEditLock, heartbeatEditLock, readEditLocks } from "@/lib/edit-lock/service";
import { evaluateLock } from "@/lib/edit-lock/rules";

const URL_BASE = process.env.PUSH_DB_TEST_URL;
const TOLERANCE_MS = 60_000;

function withTimeZone(url: string, tz: string): string {
  const u = new URL(url);
  u.searchParams.set("options", `-c TimeZone=${tz}`);
  return u.toString();
}

const near = (d: Date | string | null | undefined) =>
  d != null && Math.abs(new Date(d).getTime() - Date.now()) < TOLERANCE_MS;

const clients: PrismaClient[] = [];
afterAll(async () => {
  await Promise.all(clients.map((c) => c.$disconnect()));
});

describe.skipIf(!URL_BASE).each(["Asia/Tokyo", "UTC"])("編集の鍵の時刻(DB 接続の時間帯=%s)", (tz) => {
  const db = (() => {
    const c = new PrismaClient({ adapter: new PrismaPg(withTimeZone(URL_BASE ?? "postgres://x/x", tz)) });
    clients.push(c);
    return c;
  })();

  async function makeUser(): Promise<string> {
    const id = randomUUID();
    await db.$executeRaw`INSERT INTO "users" ("id", "email", "name", "password_hash", "updated_at")
      VALUES (${id}::uuid, ${`tz-test-${id}@example.invalid`}, 'テスト', 'x', now())`;
    return id;
  }

  it("前提: この接続の時間帯が指定どおり", async () => {
    const rows = await db.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`;
    expect(rows[0].tz).toBe(tz);
  });

  it("取った鍵の開始時刻・状態の窓口の時刻・DB の今時刻が、いまの瞬間になる", async () => {
    const userId = await makeUser();
    const target = { resourceType: "property" as const, resourceId: randomUUID() };
    try {
      const got = await acquireEditLock(db, { ...target, userId, screenTokenHash: "s1" });
      expect(got.state).toBe("mine");
      if (got.state === "mine") expect(near(got.since), `since=${got.since.toISOString()}`).toBe(true);

      const { dbNow, locks } = await readEditLocks(db, [target]);
      expect(near(dbNow), `dbNow=${dbNow.toISOString()}`).toBe(true);
      expect(locks).toHaveLength(1);
      expect(near(locks[0].acquiredAt), `acquiredAt=${locks[0].acquiredAt.toISOString()}`).toBe(true);
      expect(near(locks[0].heartbeatAt)).toBe(true);
      expect(near(locks[0].activityAt)).toBe(true);

      // 同じ利用者の別画面からは「あなたが別の画面で編集中」+開始時刻はいまの瞬間
      const st = evaluateLock(locks[0], dbNow, { userId, screenTokenHash: "s2" });
      expect(st.state).toBe("held_by_self_other_screen");
      if (st.state === "held_by_self_other_screen") expect(near(st.since)).toBe(true);
    } finally {
      await db.$executeRaw`DELETE FROM "edit_locks" WHERE "resource_id" = ${target.resourceId}::uuid`;
      await db.$executeRaw`DELETE FROM "users" WHERE "id" = ${userId}::uuid`;
    }
  });

  it("生きている鍵は、同じ利用者の別画面からも他の利用者からも横取りされない(取れない側の開始時刻もいまの瞬間)", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const target = { resourceType: "property" as const, resourceId: randomUUID() };
    try {
      const first = await acquireEditLock(db, { ...target, userId: a, screenTokenHash: "s1" });
      expect(first.state).toBe("mine");

      const otherScreen = await acquireEditLock(db, { ...target, userId: a, screenTokenHash: "s2" });
      expect(otherScreen.state).toBe("held");
      if (otherScreen.state === "held") expect(near(otherScreen.current.acquiredAt)).toBe(true);

      const otherUser = await acquireEditLock(db, { ...target, userId: b, screenTokenHash: "t1" });
      expect(otherUser.state).toBe("held");
      if (otherUser.state === "held") {
        expect(otherUser.current.userId).toBe(a);
        expect(near(otherUser.current.acquiredAt)).toBe(true);
      }

      const hb = await heartbeatEditLock(db, { ...target, userId: a, screenTokenHash: "s1", active: true });
      expect(hb.ok).toBe(true);
      if (hb.ok) expect(near(hb.idleSince), `idleSince=${hb.idleSince.toISOString()}`).toBe(true);
    } finally {
      await db.$executeRaw`DELETE FROM "edit_locks" WHERE "resource_id" = ${target.resourceId}::uuid`;
      await db.$executeRaw`DELETE FROM "users" WHERE "id" IN (${a}::uuid, ${b}::uuid)`;
    }
  });

  it("合図が途切れた鍵・操作が途切れた鍵は、他の利用者が取れる(DB の今時刻を SQL へ戻す道も正しい瞬間)", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const t1 = { resourceType: "property" as const, resourceId: randomUUID() };
    const t2 = { resourceType: "property" as const, resourceId: randomUUID() };
    try {
      expect((await acquireEditLock(db, { ...t1, userId: a, screenTokenHash: "s1" })).state).toBe("mine");
      expect((await acquireEditLock(db, { ...t2, userId: a, screenTokenHash: "s1" })).state).toBe("mine");
      // 書き込みと同じく DB の時計で、合図を10分前・操作を2時間前に戻す
      await db.$executeRaw`UPDATE "edit_locks" SET "heartbeat_at" = clock_timestamp() - INTERVAL '10 minutes' WHERE "resource_id" = ${t1.resourceId}::uuid`;
      await db.$executeRaw`UPDATE "edit_locks" SET "activity_at" = clock_timestamp() - INTERVAL '2 hours' WHERE "resource_id" = ${t2.resourceId}::uuid`;

      const { dbNow, locks } = await readEditLocks(db, [t1, t2]);
      for (const l of locks) expect(evaluateLock(l, dbNow, { userId: b, screenTokenHash: "t1" }).state).toBe("free");

      const got1 = await acquireEditLock(db, { ...t1, userId: b, screenTokenHash: "t1" });
      expect(got1.state).toBe("mine");
      if (got1.state === "mine") expect(got1.takeover?.expiredBy).toBe("heartbeat");
      const got2 = await acquireEditLock(db, { ...t2, userId: b, screenTokenHash: "t1" });
      expect(got2.state).toBe("mine");
      if (got2.state === "mine") expect(got2.takeover?.expiredBy).toBe("idle");
    } finally {
      await db.$executeRaw`DELETE FROM "edit_lock_loss_events" WHERE "resource_id" IN (${t1.resourceId}::uuid, ${t2.resourceId}::uuid)`;
      await db.$executeRaw`DELETE FROM "edit_locks" WHERE "resource_id" IN (${t1.resourceId}::uuid, ${t2.resourceId}::uuid)`;
      await db.$executeRaw`DELETE FROM "users" WHERE "id" IN (${a}::uuid, ${b}::uuid)`;
    }
  });
});
