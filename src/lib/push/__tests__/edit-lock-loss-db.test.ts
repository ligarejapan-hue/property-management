/**
 * 通知 段階4c: 編集権限が外れた知らせ(本物の Postgres)
 *
 * ⚠本物の Postgres に対して、記録づくり・送信の SQL をそのまま流して確かめる(取り合い・同時実行・
 *   カーソル・見つけ済み・時間帯など、モックでは確かめられない所)。**使い捨ての DB が要る**ので、
 *   環境変数 `PUSH_DB_TEST_URL`(全 migration を流した空の DB)があるときだけ動く。無ければ飛ばす。
 *   CI では `db-integration` の仕事が Postgres を立てて流す(.github/workflows/ci.yml)。
 *   手元では: 空の DB を作り `DATABASE_URL=<その DB> npx prisma migrate deploy` →
 *   `PUSH_DB_TEST_URL=<その DB> npx vitest run src/lib/push/__tests__/edit-lock-loss-db.test.ts`
 * ⚠この DB の中身は消す(表を空にする・申込の外部キーを外す)。共用の dev DB を指定しないこと。
 */
import { describe, it, expect, vi } from "vitest";

vi.hoisted(() => {
  const url = process.env.PUSH_DB_TEST_URL;
  if (url) {
    process.env.DATABASE_URL = url;
    // 権限は管理者相当(getUserPermissions のモック)。役割(field_staff)による範囲は DB の値で効く。
    process.env.NEXT_PUBLIC_USE_MOCK = "true";
    process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || "db-test-secret";
  }
});

// next-auth を読み込めないので api-helpers は最小の作り物にする。権限は管理者相当、所有者の表示設定は
// 本物の判定(@/lib/permissions の純関数)で導く。field_staff の範囲は DB の役割の値で効く。
vi.mock("@/lib/api-helpers", async () => {
  const { resolveOwnerDisplayConfig } = await import("@/lib/permissions");
  const granted = (resource: string, action: string) => ({ resource, action, granted: true });
  const perms = [
    granted("property", "read"), granted("property", "write"), granted("owner", "read"), granted("owner", "write"),
    granted("csv_export", "read"), granted("csv_export_personal", "read"), granted("registry", "auto_fetch"),
    ...["owner_name", "owner_name_kana", "owner_phone", "owner_zip", "owner_address", "owner_note", "owner_email", "owner_corporate_number"].map((r) => granted(r, "full")),
    ...["owner_name", "owner_name_kana", "owner_phone", "owner_zip", "owner_address", "owner_note", "owner_email", "owner_corporate_number"].map((r) => granted(r, "write")),
  ];
  class ApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    ApiError,
    getUserPermissions: async () => perms,
    getOwnerDisplayConfig: async () => resolveOwnerDisplayConfig(perms),
  };
});

import { randomUUID } from "crypto";
import prisma from "@/lib/prisma";
import { acquireEditLock, forceReleaseEditLock, recordExpiredEditLockLosses } from "@/lib/edit-lock/service";
import { runPushNotifications } from "@/lib/push/deliveries/run";
import { planEditLockLossDeliveries } from "@/lib/push/deliveries/plan";
import type { PushSender } from "@/lib/push/deliveries/web-push-sender";
import type { PushPayload } from "@/lib/push/deliveries/rules";

const failures: string[] = [];
function check(name: string, cond: boolean, extra?: unknown) {
  if (!cond) failures.push(`${name}${extra !== undefined ? " " + JSON.stringify(extra) : ""}`);
}
function fakeSender() {
  const sent: Array<{ endpoint: string; payload: PushPayload }> = [];
  const sender: PushSender = async (t, payload) => {
    sent.push({ endpoint: t.endpoint, payload });
    return { ok: true };
  };
  return { sent, sender };
}
const EP = (n: string) => `https://fcm.googleapis.com/fcm/send/${n}`;
const KEYS = { p256dh: "BOKP86iRrT4RDIC4MTCWRE1ILIQ5FhmBF1SAklaX0SRrzNrt9KdHvCuq-YF-slJ0UJn1Koqh0bjqPtO9mUWxjms", auth: "eh3yijm3LYC3dTqUVPZFbw" };

async function reset() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE edit_lock_loss_events, notification_delivery_refs, notification_deliveries, notification_source_events, push_subscriptions, edit_locks, properties, users CASCADE`,
  );
  for (const source of ["inquiry", "registry_job"]) {
    await prisma.notificationSourceCursor.upsert({
      where: { source },
      create: { source, cursorT: new Date(), cursorId: "00000000-0000-0000-0000-000000000000", updatedAt: new Date() },
      update: { cursorT: new Date() },
    });
  }
}
async function user(role = "admin") {
  const id = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (id, email, name, password_hash, updated_at, role, is_active) VALUES ($1::uuid, $2, 'x', 'x', now(), $3::"Role", true)`,
    id, `${id}@x.test`, role,
  );
  return id;
}
async function property(createdBy: string) {
  const id = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO properties (id, property_type, address, registry_status, dm_status, created_by, updated_at) VALUES ($1::uuid, 'land', 'x', 'unconfirmed', 'send', $2::uuid, now())`,
    id, createdBy,
  );
  return id;
}
/** 鍵を作る。合図・操作は「今から何分前」で(DB の時刻で入れる=アプリと同じ入れ方)。 */
async function lock(userId: string, resourceId: string, heartbeatAgoMin: number, activityAgoMin = heartbeatAgoMin) {
  const id = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO edit_locks (id, resource_type, resource_id, user_id, screen_token_hash, acquired_at, heartbeat_at, activity_at)
     VALUES ($1::uuid, 'property', $2::uuid, $3::uuid, 'h-old', clock_timestamp() - make_interval(mins => $4), clock_timestamp() - make_interval(mins => $4), clock_timestamp() - make_interval(mins => $5))`,
    id, resourceId, userId, heartbeatAgoMin, activityAgoMin,
  );
  return id;
}
async function sub(userId: string, ep: string, boundAt: Date) {
  await prisma.pushSubscription.create({
    data: { userId, endpoint: ep, ...KEYS, deviceScope: "personal", boundAt, bindingId: randomUUID(), expiresAt: new Date(Date.now() + 86400_000) },
  });
}
const near = (a: Date, b: number, ms = 3000) => Math.abs(a.getTime() - b) < ms;

async function main() {
  const tz = await prisma.$queryRawUnsafe<Array<{ tz: string }>>(`SELECT current_setting('TimeZone') AS tz`);
  void tz;

  // ---- 1. 別の人が期限切れの鍵を取り直すと、同じトランザクションで前の持ち主の記録が残る ----
  await reset();
  {
    const a = await user();
    const b = await user();
    const p = await property(a);
    const oldLock = await lock(a, p, 10);
    await prisma.$transaction(async (tx) => {
      await acquireEditLock(tx, { resourceType: "property", resourceId: p, userId: b, screenTokenHash: "h-b" });
    });
    const ev = await prisma.editLockLossEvent.findMany();
    check(
      "1 取り直しで前の持ち主・前の鍵・合図切れ・外れた時刻(合図+5分=今の5分前・UTC)を記録",
      ev.length === 1 && ev[0].lockId === oldLock && ev[0].userId === a && ev[0].cause === "heartbeat" && near(ev[0].occurredAt, Date.now() - 5 * 60_000),
      ev,
    );
  }

  // ---- 2. 管理者が外すと記録・同じ鍵をあとで取り直しても二重に記録しない ----
  await reset();
  {
    const a = await user();
    const admin = await user();
    const b = await user();
    const p = await property(a);
    const l = await lock(a, p, 0);
    await prisma.$transaction((tx) => forceReleaseEditLock(tx, { resourceType: "property", resourceId: p, lockId: l, adminUserId: admin }));
    await prisma.$transaction((tx) => acquireEditLock(tx, { resourceType: "property", resourceId: p, userId: b, screenTokenHash: "h-b" }));
    await recordExpiredEditLockLosses(prisma);
    const ev = await prisma.editLockLossEvent.findMany();
    check("2 管理者の解除を1件だけ記録(今の時刻・UTC)", ev.length === 1 && ev[0].cause === "force_released" && near(ev[0].occurredAt, Date.now()), ev);
  }

  // ---- 3. 取り直されないまま期限が過ぎた鍵は定期実行が記録・何度流しても1件 ----
  await reset();
  {
    const a = await user();
    const p = await property(a);
    await lock(a, p, 1, 61); // 合図は生きているが操作が60分を超えた
    const p2 = await property(a);
    await lock(a, p2, 1, 1); // 生きている
    const n1 = await recordExpiredEditLockLosses(prisma);
    const n2 = await recordExpiredEditLockLosses(prisma);
    const ev = await prisma.editLockLossEvent.findMany();
    check("3 期限切れの鍵だけを1件(操作切れ・外れた時刻=操作+60分)", n1 === 1 && n2 === 0 && ev.length === 1 && ev[0].cause === "idle" && near(ev[0].occurredAt, Date.now() - 60_000), { n1, n2, ev });
  }

  // ---- 3b. 2時間より前に止まった鍵は記録しない ----
  await reset();
  {
    const a = await user();
    const p = await property(a);
    await lock(a, p, 180);
    const n = await recordExpiredEditLockLosses(prisma);
    check("3b 2時間より前に止まった鍵は記録しない", n === 0, n);
  }

  // ---- 4. 送る: 外れる前から結び付いている端末に1回・文言と画面・tag ----
  await reset();
  {
    const a = await user();
    const p = await property(a);
    await sub(a, EP("pc"), new Date(Date.now() - 3600_000));
    await sub(a, EP("phone"), new Date(Date.now() - 3600_000));
    await lock(a, p, 10);
    const f = fakeSender();
    await runPushNotifications(new Date(), f.sender);
    const f2 = fakeSender();
    await runPushNotifications(new Date(), f2.sender);
    const ev = await prisma.editLockLossEvent.findFirst();
    const pl = f.sent[0]?.payload;
    check(
      "4 PC とスマホに1回ずつ・2回目は送らない・記録は queued",
      f.sent.length === 2 && f2.sent.length === 0 && ev?.status === "queued" &&
        pl?.title === "編集権限が外れました" &&
        pl?.body === "しばらく操作がなかった、または画面が止まっていたため、編集権限が外れました" &&
        pl?.url === `/properties/${p}` && pl?.tag === `edit-lock:lost:property:${p}`,
      { sent: f.sent, ev },
    );
  }

  // ---- 5. 外れたあとに結び付いた端末には送らない ----
  await reset();
  {
    const a = await user();
    const p = await property(a);
    await lock(a, p, 10); // 5分前に外れた
    await sub(a, EP("late"), new Date(Date.now() - 60_000));
    const f = fakeSender();
    await runPushNotifications(new Date(), f.sender);
    const ev = await prisma.editLockLossEvent.findFirst();
    check("5 外れたあとに結び付いた端末には送らず締める", f.sent.length === 0 && ev?.status === "queued", { sent: f.sent, ev });
  }

  // ---- 6. 1時間を過ぎた記録は送らずに締める ----
  await reset();
  {
    const a = await user();
    const p = await property(a);
    await sub(a, EP("old"), new Date(Date.now() - 5 * 3600_000));
    await lock(a, p, 95);
    const f = fakeSender();
    await runPushNotifications(new Date(), f.sender);
    const ev = await prisma.editLockLossEvent.findFirst();
    check("6 1時間を過ぎた記録は送らず expired", f.sent.length === 0 && ev?.status === "expired", { sent: f.sent, ev });
  }

  // ---- 7. 期限切れの直後に別の人が取り直しても、前の持ち主に届く ----
  await reset();
  {
    const a = await user();
    const b = await user();
    const p = await property(a);
    await sub(a, EP("a"), new Date(Date.now() - 3600_000));
    await sub(b, EP("b"), new Date(Date.now() - 3600_000));
    await lock(a, p, 6);
    await prisma.$transaction((tx) => acquireEditLock(tx, { resourceType: "property", resourceId: p, userId: b, screenTokenHash: "h-b" }));
    const f = fakeSender();
    await runPushNotifications(new Date(), f.sender);
    check("7 取り直されても前の持ち主(だけ)に届く", f.sent.length === 1 && f.sent[0].endpoint === EP("a"), f.sent);
  }

  // ---- 8. 2つの実行が同時でも端末ごとに1回 ----
  await reset();
  {
    const a = await user();
    const p = await property(a);
    await sub(a, EP("x"), new Date(Date.now() - 3600_000));
    await lock(a, p, 10);
    await recordExpiredEditLockLosses(prisma);
    const [n1, n2] = await Promise.all([planEditLockLossDeliveries(new Date()), planEditLockLossDeliveries(new Date())]);
    const d = await prisma.notificationDelivery.count({ where: { kind: "edit_lock_lost" } });
    check("8 同時に動かしても送信記録は1つ", n1 + n2 === 1 && d === 1, { n1, n2, d });
  }

  // ---- 9. 送る前に、今もその資源を編集できるかを確かめる ----
  await reset();
  {
    const a = await user();
    const p = await property(a);
    await sub(a, EP("arch"), new Date(Date.now() - 3600_000));
    await lock(a, p, 10);
    await recordExpiredEditLockLosses(prisma);
    await planEditLockLossDeliveries(new Date());
    await prisma.$executeRawUnsafe(`UPDATE properties SET is_archived = true WHERE id = $1::uuid`, p);
    const f = fakeSender();
    await runPushNotifications(new Date(), f.sender);
    check("9a アーカイブされた物件の知らせは送らない", f.sent.length === 0, f.sent);
  }
  await reset();
  {
    const boss = await user();
    const fs = await user("field_staff");
    const p = await property(fs);
    await sub(fs, EP("fs"), new Date(Date.now() - 3600_000));
    await lock(fs, p, 10);
    await recordExpiredEditLockLosses(prisma);
    await planEditLockLossDeliveries(new Date());
    await prisma.$executeRawUnsafe(`UPDATE properties SET created_by = $2::uuid, assigned_to = $2::uuid WHERE id = $1::uuid`, p, boss);
    const f = fakeSender();
    await runPushNotifications(new Date(), f.sender);
    check("9b 担当から外れた field_staff には送らない", f.sent.length === 0, f.sent);
  }

  // ---- 10. 本人が同じ記録の鍵を取り直して編集を続けているなら送らない ----
  await reset();
  {
    const a = await user();
    const p = await property(a);
    await sub(a, EP("back"), new Date(Date.now() - 3600_000));
    await lock(a, p, 10);
    await recordExpiredEditLockLosses(prisma);
    await prisma.$transaction((tx) => acquireEditLock(tx, { resourceType: "property", resourceId: p, userId: a, screenTokenHash: "h-new-tab" }));
    const f = fakeSender();
    await runPushNotifications(new Date(), f.sender);
    check("10 本人が鍵を取り直して編集中なら送らない", f.sent.length === 0, f.sent);
  }

  // ---- 11. 編集権限の知らせは、ほかの溜まった送信より先に送る ----
  await reset();
  {
    const a = await user();
    const p = await property(a);
    await sub(a, EP("q"), new Date(Date.now() - 3600_000));
    const s2 = await prisma.pushSubscription.findFirstOrThrow({ where: { userId: a } });
    const old = new Date(Date.now() - 30 * 60_000);
    await prisma.notificationDelivery.createMany({
      data: Array.from({ length: 250 }, () => ({ id: randomUUID(), userId: a, subscriptionId: s2.id, bindingId: s2.bindingId, kind: "next_action", scheduledFor: old })),
    });
    await lock(a, p, 10);
    await recordExpiredEditLockLosses(prisma);
    await planEditLockLossDeliveries(new Date());
    const { sendDueDeliveries } = await import("@/lib/push/deliveries/send");
    const f = fakeSender();
    await sendDueDeliveries(new Date(), f.sender);
    const lost = await prisma.notificationDelivery.findFirst({ where: { kind: "edit_lock_lost" } });
    check("11 溜まった送信があっても編集権限の知らせは先に送る", lost?.status === "sent" || lost?.status === "cancelled" ? lost.status === "sent" : false, lost);
  }

  // ---- 12. 端末の多い人の知らせは、1回「件×端末」2,000までに分けて作る ----
  await reset();
  {
    const a = await user();
    const p1 = await property(a);
    const p2 = await property(a);
    await prisma.pushSubscription.createMany({
      data: Array.from({ length: 1500 }, (_, i) => ({
        userId: a, endpoint: EP(`many-${i}`), ...KEYS, deviceScope: "personal", boundAt: new Date(Date.now() - 3600_000),
        bindingId: randomUUID(), expiresAt: new Date(Date.now() + 86400_000),
      })),
    });
    await lock(a, p1, 12);
    await lock(a, p2, 10);
    await recordExpiredEditLockLosses(prisma);
    const n1 = await planEditLockLossDeliveries(new Date());
    const pending1 = await prisma.editLockLossEvent.count({ where: { status: "pending" } });
    const n2 = await planEditLockLossDeliveries(new Date());
    const pending2 = await prisma.editLockLossEvent.count({ where: { status: "pending" } });
    check("12 端末の多い人は1回2,000までに分け、次の回で残りを作る", n1 === 2000 && pending1 === 1 && n2 === 1000 && pending2 === 0, { n1, pending1, n2, pending2 });
  }

  // ---- 13. 1件で2,000台を超えるときも、1回2,000台までで次の回に続ける ----
  await reset();
  {
    const a = await user();
    const p1 = await property(a);
    await prisma.pushSubscription.createMany({
      data: Array.from({ length: 2500 }, (_, i) => ({
        userId: a, endpoint: EP(`huge-${i}`), ...KEYS, deviceScope: "personal", boundAt: new Date(Date.now() - 3600_000),
        bindingId: randomUUID(), expiresAt: new Date(Date.now() + 86400_000),
      })),
    });
    await lock(a, p1, 10);
    await recordExpiredEditLockLosses(prisma);
    const n1 = await planEditLockLossDeliveries(new Date());
    const st1 = (await prisma.editLockLossEvent.findFirstOrThrow()).status;
    const n2 = await planEditLockLossDeliveries(new Date());
    const st2 = (await prisma.editLockLossEvent.findFirstOrThrow()).status;
    const refs = await prisma.notificationDeliveryRef.count();
    check("13 1件で2,500台でも1回2,000台まで・次の回で残り500台・重ならない", n1 === 2000 && st1 === "pending" && n2 === 500 && st2 === "queued" && refs === 2500, { n1, st1, n2, st2, refs });
  }

}

describe.skipIf(!process.env.PUSH_DB_TEST_URL)("通知 段階4c: 編集権限が外れた知らせ(本物の Postgres)", () => {
  it("すべての確認項目が通る", async () => {
    try {
      await main();
    } finally {
      await prisma.$disconnect();
    }
    expect(failures).toEqual([]);
  }, 600_000);
});
