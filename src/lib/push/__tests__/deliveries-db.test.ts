/**
 * 通知 段階4b: 記録づくりと送信(本物の Postgres)
 *
 * ⚠本物の Postgres に対して、記録づくり・送信の SQL をそのまま流して確かめる(取り合い・同時実行・
 *   カーソル・見つけ済み・時間帯など、モックでは確かめられない所)。**使い捨ての DB が要る**ので、
 *   環境変数 `PUSH_DB_TEST_URL`(全 migration を流した空の DB)があるときだけ動く。無ければ飛ばす。
 *   CI では `db-integration` の仕事が Postgres を立てて流す(.github/workflows/ci.yml)。
 *   手元では: 空の DB を作り `DATABASE_URL=<その DB> npx prisma migrate deploy` →
 *   `PUSH_DB_TEST_URL=<その DB> npx vitest run src/lib/push/__tests__/deliveries-db.test.ts`
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
import { Client } from "pg";
import prisma from "@/lib/prisma";
import { runPushNotifications } from "@/lib/push/deliveries/run";
import { planNextActionDeliveries, planSourceDeliveries } from "@/lib/push/deliveries/plan";
import { sendDueDeliveries, sendOne } from "@/lib/push/deliveries/send";
import { upsertPushSubscription } from "@/lib/push/subscriptions";
import type { PushSender, PushTarget } from "@/lib/push/deliveries/web-push-sender";
import type { PushPayload, SendOutcome } from "@/lib/push/deliveries/rules";

const URL_ = process.env.PUSH_DB_TEST_URL ?? "";
const failures: string[] = [];
function check(name: string, cond: boolean, extra?: unknown) {
  if (!cond) failures.push(`${name}${extra !== undefined ? " " + JSON.stringify(extra) : ""}`);
}

type Sent = { endpoint: string; payload: PushPayload };
function fakeSender(outcomes: (t: PushTarget) => SendOutcome = () => ({ ok: true }), delayMs = 0) {
  const sent: Sent[] = [];
  const sender: PushSender = async (t, payload) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const o = outcomes(t);
    if (o.ok) sent.push({ endpoint: t.endpoint, payload });
    return o;
  };
  return { sent, sender };
}

const EP = (n: string) => `https://fcm.googleapis.com/fcm/send/${n}`;
const KEYS = { p256dh: "BOKP86iRrT4RDIC4MTCWRE1ILIQ5FhmBF1SAklaX0SRrzNrt9KdHvCuq-YF-slJ0UJn1Koqh0bjqPtO9mUWxjms", auth: "eh3yijm3LYC3dTqUVPZFbw" };
const JST = (s: string) => new Date(`${s}+09:00`);

// ---- 試験の「今日」(日本時間)は実行した日の翌日にする(実際の日付に依存させない) ----
// ⚠本番のコードは「渡された時刻」と「今の時刻」の遅い方で判定する所がある(送る直前の確かめ直し・
//   取り合いの時刻=max(now, Date.now()))。試験の時刻 NOW(今日の 10:00)が実際の時刻より過去になると、
//   回の判定が実際の時刻で行われて結果が変わる。翌日にすれば NOW は常に実際の時刻より 10〜34 時間先で、
//   渡した時刻どおりに判定される。時・分(9:00 の回・+2h=11:00・15:00 の5分前など)は日付によらないので固定のまま。
const DAY_MS = 24 * 60 * 60 * 1000;
const jstYmd = (ms: number) => new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
const jstDayOffset = (ymd: string, days: number) => jstYmd(Date.parse(`${ymd}T00:00:00Z`) + days * DAY_MS);
/** 試験の「今日」(次回対応の予定日)。 */
const D_TODAY = jstYmd(Date.now() + DAY_MS);
/** 前日(期限切れの次回対応)。 */
const D_PREV = jstDayOffset(D_TODAY, -1);
/** 端末を結び付けた日(今日の4日前=どの回よりも前)。 */
const D_BOUND = jstDayOffset(D_TODAY, -4);

async function reset() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE notification_delivery_refs, notification_deliveries, notification_fanout_queue, notification_source_events, push_subscriptions, next_actions, dm_inquiries, registry_fetch_job_items, registry_fetch_jobs, properties, users CASCADE`,
  );
  for (const source of ["inquiry", "registry_job"]) {
    await prisma.notificationSourceCursor.upsert({
      where: { source },
      create: { source, cursorT: new Date(), cursorId: "00000000-0000-0000-0000-000000000000", updatedAt: new Date() },
      update: { cursorT: new Date(), cursorId: "00000000-0000-0000-0000-000000000000" },
    });
  }
}

async function user(opts: { role?: string; notify?: boolean } = {}) {
  const id = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (id, email, name, password_hash, updated_at, role, is_active, inquiry_notify_enabled) VALUES ($1::uuid, $2, 'x', 'x', now(), $3::"Role", true, $4)`,
    id, `${id}@x.test`, opts.role ?? "admin", opts.notify ?? false,
  );
  return id;
}
async function property(createdBy: string, assignedTo: string | null = null) {
  const id = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO properties (id, property_type, address, registry_status, dm_status, created_by, assigned_to, updated_at) VALUES ($1::uuid, 'land', 'x', 'unconfirmed', 'send', $2::uuid, $3::uuid, now())`,
    id, createdBy, assignedTo,
  );
  return id;
}
async function action(propertyId: string, assignee: string, ymd: string, time: string | null = null) {
  const id = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO next_actions (id, property_id, assigned_to, scheduled_at, scheduled_time, content, created_by, updated_at) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5, 'x', $3::uuid, now())`,
    id, propertyId, assignee, ymd, time,
  );
  return id;
}
async function sub(userId: string, ep: string, boundAt: Date, scope: "shared" | "personal" = "personal", expiresAt = new Date(Date.now() + 86400_000 * 30)) {
  const id = randomUUID();
  const bindingId = randomUUID();
  await prisma.pushSubscription.create({
    data: { id, userId, endpoint: ep, ...KEYS, deviceScope: scope, boundAt, bindingId, expiresAt },
  });
  return { id, bindingId };
}

async function main() {
  // 申込は下書き(draft)無しで入れたいので、使い捨て DB だけ外部キーを外す。
  await prisma.$executeRawUnsafe(`ALTER TABLE dm_inquiries DROP CONSTRAINT IF EXISTS dm_inquiries_draft_id_fkey`);

  // ---- 1. 次回対応: 9:00 の回を1通・同じ回は2回送らない ----
  await reset();
  const NOW = JST(`${D_TODAY}T10:00:00`);
  const u1 = await user();
  const p1 = await property(u1);
  await action(p1, u1, D_TODAY);
  const s1 = await sub(u1, EP("a"), JST(`${D_BOUND}T00:00:00`));
  let f = fakeSender();
  const r = await runPushNotifications(NOW, f.sender);
  check("1a 9:00 の回を1通送る", f.sent.length === 1 && f.sent[0].payload.body === "今日の次回対応が1件あります" && f.sent[0].payload.b === s1.bindingId, { r, sent: f.sent });
  f = fakeSender();
  await runPushNotifications(new Date(NOW.getTime() + 60_000), f.sender);
  check("1b 同じ回はもう送らない", f.sent.length === 0, f.sent);
  f = fakeSender();
  await runPushNotifications(JST(`${D_TODAY}T11:00:00`), f.sender);
  check("1c 次の回(+2h=11:00)を送る", f.sent.length === 1, f.sent);

  // ---- 2. 定期実行を2本同時に動かしても1通 ----
  await reset();
  {
    const u = await user();
    const p = await property(u);
    await action(p, u, D_TODAY);
    await action(p, u, D_PREV);
    await sub(u, EP("b"), JST(`${D_BOUND}T00:00:00`));
    f = fakeSender(undefined, 300);
    await Promise.all([runPushNotifications(NOW, f.sender), runPushNotifications(NOW, f.sender)]);
    check("2 二重に動かしても端末ごとに1通(2件を1通にまとめる)", f.sent.length === 1 && f.sent[0].payload.body === "今日の次回対応が1件、期限切れが1件あります", f.sent);
  }

  // ---- 3. PC は成功・スマホは失敗 → スマホだけ送り直す ----
  await reset();
  {
    const u = await user();
    const p = await property(u);
    await action(p, u, D_TODAY);
    await sub(u, EP("pc"), JST(`${D_BOUND}T00:00:00`));
    await sub(u, EP("phone"), JST(`${D_BOUND}T00:00:00`));
    f = fakeSender((t) => (t.endpoint === EP("phone") ? { ok: false, gone: false, code: "http_500" } : { ok: true }));
    await runPushNotifications(NOW, f.sender);
    f = fakeSender();
    await runPushNotifications(new Date(NOW.getTime() + 60_000), f.sender);
    const tooSoon = f.sent.length;
    await runPushNotifications(new Date(NOW.getTime() + 11 * 60_000), f.sender);
    check("3a 送り直しは10分あける", tooSoon === 0, tooSoon);
    check("3 失敗した端末だけ次の実行で送り直す", f.sent.length === 1 && f.sent[0].endpoint === EP("phone"), f.sent);
  }

  // ---- 4. 404/410 で登録を無効にする ----
  await reset();
  {
    const u = await user();
    const p = await property(u);
    await action(p, u, D_TODAY);
    const s = await sub(u, EP("g"), JST(`${D_BOUND}T00:00:00`));
    f = fakeSender(() => ({ ok: false, gone: true, code: "http_410" }));
    await runPushNotifications(NOW, f.sender);
    const row = await prisma.pushSubscription.findUnique({ where: { id: s.id } });
    check("4 410 で登録を無効(gone)にする", row?.revokedReason === "gone" && row.revokedAt !== null, row);
  }

  // ---- 5. 付け替え: 前の結び付けの送り待ちは取り消す・前の人宛ては送らない ----
  await reset();
  {
    const a = await user();
    const b = await user();
    const p = await property(a);
    await action(p, a, D_TODAY);
    await sub(a, EP("shared"), JST(`${D_BOUND}T00:00:00`));
    await planNextActionDeliveries(NOW);
    const pend = await prisma.notificationDelivery.count({ where: { status: "pending" } });
    await upsertPushSubscription(b, { endpoint: EP("shared"), ...KEYS }, NOW);
    f = fakeSender();
    await sendDueDeliveries(NOW, f.sender);
    const cancelled = await prisma.notificationDelivery.count({ where: { status: "cancelled", lastErrorCode: "rebound" } });
    check("5 別の人に付け替えたら前の人宛ての送り待ちは取り消し・送らない", pend === 1 && cancelled === 1 && f.sent.length === 0, { pend, cancelled, sent: f.sent });
  }

  // ---- 6. 送る直前の確かめ直し: 完了したら送らず取り消し・記録の件も消す ----
  await reset();
  {
    const u = await user();
    const p = await property(u);
    const id = await action(p, u, D_TODAY);
    await sub(u, EP("c"), JST(`${D_BOUND}T00:00:00`));
    await planNextActionDeliveries(NOW);
    await prisma.nextAction.update({ where: { id }, data: { isCompleted: true } });
    f = fakeSender();
    await sendDueDeliveries(NOW, f.sender);
    const refs = await prisma.notificationDeliveryRef.count();
    const st = await prisma.notificationDelivery.findFirst({ select: { status: true, lastErrorCode: true } });
    check("6 完了した件は送らず cancelled・含めた件の記録を消す", f.sent.length === 0 && refs === 0 && st?.status === "cancelled", { st, refs });
  }

  // ---- 7. 担当替え: 前の担当者には送らない ----
  await reset();
  {
    const a = await user();
    const b = await user();
    const p = await property(a);
    const id = await action(p, a, D_TODAY);
    await sub(a, EP("d"), JST(`${D_BOUND}T00:00:00`));
    await planNextActionDeliveries(NOW);
    await prisma.nextAction.update({ where: { id }, data: { assignedTo: b } });
    f = fakeSender();
    await sendDueDeliveries(NOW, f.sender);
    check("7 担当を替えたら前の担当者には送らない", f.sent.length === 0, f.sent);
  }

  // ---- 8. 期限切れの shared 端末には送らない ----
  await reset();
  {
    const u = await user();
    const p = await property(u);
    await action(p, u, D_TODAY);
    await sub(u, EP("e"), JST(`${D_BOUND}T00:00:00`), "shared", new Date(NOW.getTime() - 1));
    f = fakeSender();
    await runPushNotifications(NOW, f.sender);
    check("8 期限切れの shared 端末には送らない", f.sent.length === 0 && (await prisma.notificationDelivery.count()) === 0, f.sent);
  }

  // ---- 9. 時刻あり: 5分前に「15:00 の次回対応が1件」 ----
  await reset();
  {
    const u = await user();
    const p = await property(u);
    await action(p, u, D_TODAY, "15:00");
    await sub(u, EP("t"), JST(`${D_BOUND}T00:00:00`));
    f = fakeSender();
    await runPushNotifications(JST(`${D_TODAY}T14:54:00`), f.sender);
    const early = f.sent.length;
    await runPushNotifications(JST(`${D_TODAY}T14:56:00`), f.sender);
    check("9 時刻ありは5分前に時刻つきの文言で送る", early === 0 && f.sent.length === 1 && f.sent[0].payload.body === "15:00 の次回対応が1件あります", f.sent);
  }

  // ---- 10. 結び付けより前の回は送らない ----
  await reset();
  {
    const u = await user();
    const p = await property(u);
    await action(p, u, D_TODAY);
    await sub(u, EP("late"), JST(`${D_TODAY}T09:30:00`));
    f = fakeSender();
    await runPushNotifications(NOW, f.sender);
    check("10 結び付けより前の回(9:00)は送らない", f.sent.length === 0, f.sent);
  }

  // ---- 11. 端末の行を押さえられていたら待たずに飛ばし、次の実行で1回だけ送る ----
  await reset();
  {
    const u = await user();
    const p = await property(u);
    await action(p, u, D_TODAY);
    const s = await sub(u, EP("lock"), JST(`${D_BOUND}T00:00:00`));
    await planNextActionDeliveries(NOW);
    const c = new Client({ connectionString: URL_ });
    await c.connect();
    await c.query("BEGIN");
    await c.query(`SELECT 1 FROM push_subscriptions WHERE id = $1 FOR UPDATE`, [s.id]);
    f = fakeSender();
    const t0 = Date.now();
    const st = await sendDueDeliveries(NOW, f.sender);
    const waited = Date.now() - t0;
    await c.query("ROLLBACK");
    await c.end();
    const busySent = f.sent.length;
    await sendDueDeliveries(NOW, f.sender);
    await sendDueDeliveries(NOW, f.sender);
    check("11 押さえられた端末は待たずに飛ばし、次で1回だけ送る", st.busy === 1 && busySent === 0 && waited < 3000 && f.sent.length === 1, { st, waited, n: f.sent.length });
  }

  // ---- 12. 15分を過ぎた sending は取り直す・元の処理の結果は書けない ----
  await reset();
  {
    const u = await user();
    const p = await property(u);
    await action(p, u, D_TODAY);
    await sub(u, EP("stale"), JST(`${D_BOUND}T00:00:00`));
    await planNextActionDeliveries(NOW);
    const d = await prisma.notificationDelivery.findFirstOrThrow();
    const oldClaim = new Date(NOW.getTime() - 16 * 60_000);
    await prisma.notificationDelivery.update({ where: { id: d.id }, data: { status: "sending", claimedAt: oldClaim, attempts: 1 } });
    f = fakeSender();
    const res = await sendOne(d.id, NOW, f.sender);
    const late = await prisma.notificationDelivery.updateMany({ where: { id: d.id, status: "sending", claimedAt: oldClaim }, data: { status: "failed" } });
    const after = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: d.id } });
    check("12 15分過ぎの sending は取り直して送る・元の処理は上書きできない", res === "sent" && late.count === 0 && after.status === "sent" && f.sent.length === 1, { res, late: late.count, st: after.status });
    // 15分以内の sending は取らない
    await prisma.notificationDelivery.update({ where: { id: d.id }, data: { status: "sending", claimedAt: new Date(NOW.getTime() - 60_000) } });
    const res2 = await sendOne(d.id, NOW, f.sender);
    check("12b 15分以内の sending は取らない", res2 === "skipped" && f.sent.length === 1, res2);
  }

  // ---- 13. 査定申込: 反映前は送らない・新着は通知 ON の人に1回・遅れて確定した行も拾う ----
  await reset();
  {
    const on = await user({ notify: true });
    const off = await user({ notify: false });
    await sub(on, EP("inq-on"), new Date(Date.now() - 3600_000));
    await sub(off, EP("inq-off"), new Date(Date.now() - 3600_000));
    const now0 = new Date();
    await prisma.notificationSourceCursor.update({ where: { source: "inquiry" }, data: { cursorT: now0, cursorId: "00000000-0000-0000-0000-000000000000" } });
    const ins = async (t: Date) => {
      const id = randomUUID();
      await prisma.$executeRawUnsafe(`INSERT INTO dm_inquiries (id, draft_id, name, phone, submitted_at) VALUES ($1::uuid, $2::uuid, 'x', 'x', $3::timestamptz AT TIME ZONE 'UTC')`, id, randomUUID(), t.toISOString());
      return id;
    };
    await ins(new Date(now0.getTime() - 10 * 60_000)); // 反映(カーソル)より前・読み直し範囲の外
    f = fakeSender();
    await runPushNotifications(new Date(), f.sender);
    const before = f.sent.length;
    await ins(new Date(now0.getTime() + 1000));
    await ins(new Date(now0.getTime() - 2 * 60_000)); // 時刻はカーソルより前だが遅れて確定(読み直しで拾う)
    f = fakeSender();
    await runPushNotifications(new Date(), f.sender);
    const first = f.sent.map((s) => `${s.endpoint}|${s.payload.body}`);
    f = fakeSender();
    await runPushNotifications(new Date(), f.sender);
    check("13 反映前は送らず、新着(遅れて確定した行も)を通知 ON の人に1回だけ", before === 0 && first.length === 1 && first[0] === `${EP("inq-on")}|新しい査定の申込が2件あります` && f.sent.length === 0, { before, first, again: f.sent });
  }

  // ---- 14. 見つけたあとに結び付いた端末には、その出来事を送らない ----
  await reset();
  {
    const on = await user({ notify: true });
    const now0 = new Date();
    await prisma.notificationSourceCursor.update({ where: { source: "inquiry" }, data: { cursorT: new Date(now0.getTime() - 60_000), cursorId: "00000000-0000-0000-0000-000000000000" } });
    await prisma.$executeRawUnsafe(`INSERT INTO dm_inquiries (id, draft_id, name, phone, submitted_at) VALUES ($1::uuid, $2::uuid, 'x', 'x', $3::timestamptz AT TIME ZONE 'UTC')`, randomUUID(), randomUUID(), now0.toISOString());
    await planSourceDeliveries("inquiry", new Date()); // 端末がまだ無いときに見つける
    await sub(on, EP("inq-late"), new Date());
    f = fakeSender();
    await runPushNotifications(new Date(Date.now() + 1000), f.sender);
    check("14 見つけたあとに結び付いた端末には送らない", f.sent.length === 0, f.sent);
  }

  // ---- 15. 謄本ジョブの完了: 作った本人に件数つきで ----
  await reset();
  {
    const u = await user();
    const p = await property(u);
    await sub(u, EP("reg"), new Date(Date.now() - 3600_000));
    const now0 = new Date();
    await prisma.notificationSourceCursor.update({ where: { source: "registry_job" }, data: { cursorT: new Date(now0.getTime() - 1000), cursorId: "00000000-0000-0000-0000-000000000000" } });
    const jobId = randomUUID();
    await prisma.$executeRawUnsafe(`INSERT INTO registry_fetch_jobs (id, certificate_type, requested_by_id, status, completed_at, updated_at) VALUES ($1::uuid, 'x', $2::uuid, 'completed', $3::timestamptz AT TIME ZONE 'UTC', now())`, jobId, u, now0.toISOString());
    for (const st of ["done", "done", "failed"]) {
      await prisma.$executeRawUnsafe(`INSERT INTO registry_fetch_job_items (id, job_id, property_id, status, updated_at) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, now())`, randomUUID(), jobId, p, st);
    }
    f = fakeSender();
    await runPushNotifications(new Date(), f.sender);
    check("15 謄本ジョブの完了を件数つきで1通", f.sent.length === 1 && f.sent[0].payload.body === "謄本の一括取得が完了しました（成功2件・失敗1件）" && f.sent[0].payload.url === `/properties/registry-fetch/${jobId}` && !f.sent[0].payload.tag.includes(jobId), f.sent);
  }

  // ---- 16. field_staff: 担当から外れた物件の次回対応は送らない ----
  await reset();
  {
    const boss = await user();
    const fs = await user({ role: "field_staff" });
    const pOther = await property(boss, boss);
    await action(pOther, fs, D_TODAY);
    await sub(fs, EP("fs"), JST(`${D_BOUND}T00:00:00`));
    f = fakeSender();
    await runPushNotifications(NOW, f.sender);
    check("16 field_staff は担当範囲外の物件の次回対応を受け取らない", f.sent.length === 0, f.sent);
  }

  // ---- 18. 回が進んだら古い回の送り直しはやめ、新しい回の1通だけ ----
  await reset();
  {
    const u = await user();
    const p = await property(u);
    await action(p, u, D_TODAY);
    await sub(u, EP("slot"), JST(`${D_BOUND}T00:00:00`));
    f = fakeSender(() => ({ ok: false, gone: false, code: "http_500" }));
    await runPushNotifications(JST(`${D_TODAY}T10:50:00`), f.sender); // 9:00 の回で失敗
    f = fakeSender();
    await runPushNotifications(JST(`${D_TODAY}T11:01:00`), f.sender); // 11:00 の回
    check("18 回が進んだら古い回は送り直さず新しい回の1通だけ", f.sent.length === 1, f.sent);
  }

  // ---- 19. 確かめ直しは送る時刻で: 作った後に回が進んでいたら古い回は送らない ----
  await reset();
  {
    const u = await user();
    const p = await property(u);
    await action(p, u, D_TODAY);
    await sub(u, EP("late-send"), JST(`${D_BOUND}T00:00:00`));
    await planNextActionDeliveries(JST(`${D_TODAY}T10:59:00`));
    f = fakeSender();
    const st = await sendDueDeliveries(JST(`${D_TODAY}T11:01:00`), f.sender);
    check("19 作った後に回が進んだら古い回は送らない", f.sent.length === 0 && st.cancelled === 1, { st, sent: f.sent });
  }

  // ---- 20. 持ち時間を過ぎたら新しい送信を始めない ----
  await reset();
  {
    const u = await user();
    const p = await property(u);
    await action(p, u, D_TODAY);
    await sub(u, EP("budget"), JST(`${D_BOUND}T00:00:00`));
    await planNextActionDeliveries(NOW);
    f = fakeSender();
    await sendDueDeliveries(NOW, f.sender, { budgetMs: 0 });
    const none = f.sent.length;
    await sendDueDeliveries(NOW, f.sender);
    check("20 持ち時間を過ぎたら送らず、次の実行で送る", none === 0 && f.sent.length === 1, { none, n: f.sent.length });
  }

  // ---- 21. 実行の途中で結び付いた端末も、見つけた時点で結び付いていれば送る ----
  await reset();
  {
    const on = await user({ notify: true });
    const runStart = new Date(Date.now() - 60_000);
    await prisma.notificationSourceCursor.update({ where: { source: "inquiry" }, data: { cursorT: new Date(Date.now() - 120_000), cursorId: "00000000-0000-0000-0000-000000000000" } });
    await sub(on, EP("mid-run"), new Date(Date.now() - 30_000));
    await prisma.$executeRawUnsafe(`INSERT INTO dm_inquiries (id, draft_id, name, phone, submitted_at) VALUES ($1::uuid, $2::uuid, 'x', 'x', $3::timestamptz AT TIME ZONE 'UTC')`, randomUUID(), randomUUID(), new Date(Date.now() - 10_000).toISOString());
    const n = (await planSourceDeliveries("inquiry", runStart)).created;
    check("21 実行の途中で結び付いた端末にも送る(見つけた時刻で判定)", n === 1, n);
  }

  // ---- 22. 持ち時間を過ぎたら記録づくりも新しく始めない ----
  await reset();
  {
    const u = await user();
    const p = await property(u);
    await action(p, u, D_TODAY);
    await sub(u, EP("plan-budget"), JST(`${D_BOUND}T00:00:00`));
    const n0 = await planNextActionDeliveries(NOW, { deadlineMs: Date.now() - 1 });
    const n1 = await planNextActionDeliveries(NOW, { deadlineMs: Date.now() + 60_000 });
    check("22 持ち時間を過ぎたら記録を作らず、次の実行で作る", n0 === 0 && n1 === 1, { n0, n1 });
  }

  // ---- 23. 回数を使い切った送信中の残骸は取り直さず failed で締める ----
  await reset();
  {
    const u = await user();
    const p = await property(u);
    await action(p, u, D_TODAY);
    await sub(u, EP("abandon"), JST(`${D_BOUND}T00:00:00`));
    await planNextActionDeliveries(NOW);
    const d = await prisma.notificationDelivery.findFirstOrThrow();
    await prisma.notificationDelivery.update({ where: { id: d.id }, data: { status: "sending", claimedAt: new Date(NOW.getTime() - 16 * 60_000), attempts: 3 } });
    f = fakeSender();
    await sendDueDeliveries(NOW, f.sender);
    const after = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: d.id } });
    check("23 使い切った送信中の残骸は送らず failed(abandoned)", f.sent.length === 0 && after.status === "failed" && after.lastErrorCode === "abandoned", after);
  }

  // ---- 24. 送る前の処理が長引いたら送らずに巻き戻す(取り合いも消える) ----
  await reset();
  {
    const u = await user();
    const p = await property(u);
    await action(p, u, D_TODAY);
    await sub(u, EP("slow"), JST(`${D_BOUND}T00:00:00`));
    await planNextActionDeliveries(NOW);
    const d = await prisma.notificationDelivery.findFirstOrThrow();
    f = fakeSender();
    const res = await sendOne(d.id, NOW, f.sender, { presendLimitMs: -1 });
    const after = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: d.id } });
    check("24 送る前が長引いたら送らず、取り合いを元に戻す", res === "busy" && f.sent.length === 0 && after.status === "pending" && after.attempts === 0 && after.claimedAt === null, { res, after });
  }

  // ---- 25. 30日を過ぎた記録を片付ける ----
  await reset();
  {
    const u = await user();
    const s = await sub(u, EP("purge"), JST(`${D_BOUND}T00:00:00`));
    await prisma.notificationDelivery.create({ data: { userId: u, subscriptionId: s.id, bindingId: s.bindingId, kind: "next_action", scheduledFor: NOW, status: "sent", createdAt: new Date(Date.now() - 31 * 86400_000) } });
    await prisma.notificationDelivery.create({ data: { userId: u, subscriptionId: s.id, bindingId: s.bindingId, kind: "next_action", scheduledFor: NOW, status: "sent" } });
    const r = await runPushNotifications(new Date(), fakeSender().sender);
    check("25 30日を過ぎた記録だけ片付ける", r.purged.deliveries === 1 && (await prisma.notificationDelivery.count()) === 1, r.purged);
  }

  // ---- 26. 申込が多くても1トランザクション100件ずつ進め、全部を1回ずつ知らせる ----
  await reset();
  {
    const on = await user({ notify: true });
    await sub(on, EP("many"), new Date(Date.now() - 3600_000));
    const base = Date.now() - 60_000;
    await prisma.notificationSourceCursor.update({ where: { source: "inquiry" }, data: { cursorT: new Date(base - 1000), cursorId: "00000000-0000-0000-0000-000000000000" } });
    for (let i = 0; i < 150; i++) {
      await prisma.$executeRawUnsafe(`INSERT INTO dm_inquiries (id, draft_id, name, phone, submitted_at) VALUES ($1::uuid, $2::uuid, 'x', 'x', $3::timestamptz AT TIME ZONE 'UTC')`, randomUUID(), randomUUID(), new Date(base + i * 10).toISOString());
    }
    f = fakeSender();
    await runPushNotifications(new Date(), f.sender);
    const refs = await prisma.notificationDeliveryRef.count({ where: { kind: "inquiry_new" } });
    const seen = await prisma.notificationSourceEvent.count({ where: { source: "inquiry" } });
    const total = f.sent.reduce((n, x) => n + Number(/(\d+)件/.exec(x.payload.body)?.[1] ?? 0), 0);
    check("26 150件を100件ずつに分けて記録し、端末には1通にまとめて知らせる", refs === 150 && seen === 150 && total === 150 && f.sent.length === 1, { refs, seen, total, n: f.sent.length });
  }

  // ---- 27. 取り合いは送る前に確定している(送信中に落ちても回数と取り合いが残る) ----
  await reset();
  {
    const u = await user();
    const p = await property(u);
    await action(p, u, D_TODAY);
    await sub(u, EP("durable"), JST(`${D_BOUND}T00:00:00`));
    await planNextActionDeliveries(NOW);
    const c = new Client({ connectionString: URL_ });
    await c.connect();
    let seenDuring: unknown = null;
    const sender: PushSender = async () => {
      seenDuring = (await c.query(`SELECT status, attempts FROM notification_deliveries`)).rows[0];
      return { ok: true };
    };
    await sendDueDeliveries(NOW, sender);
    await c.end();
    check("27 送信中にほかの接続から見ても sending・回数1(確定済み)", JSON.stringify(seenDuring) === JSON.stringify({ status: "sending", attempts: 1 }), seenDuring);
  }

  // ---- 28. 端末が多くても記録づくりはまとめて(300台に1件ずつ・1回で) ----
  await reset();
  {
    const on = await user({ notify: true });
    for (let i = 0; i < 300; i++) await sub(on, EP(`fan-${i}`), new Date(Date.now() - 3600_000));
    await prisma.notificationSourceCursor.update({ where: { source: "inquiry" }, data: { cursorT: new Date(Date.now() - 60_000), cursorId: "00000000-0000-0000-0000-000000000000" } });
    await prisma.$executeRawUnsafe(`INSERT INTO dm_inquiries (id, draft_id, name, phone, submitted_at) VALUES ($1::uuid, $2::uuid, 'x', 'x', $3::timestamptz AT TIME ZONE 'UTC')`, randomUUID(), randomUUID(), new Date(Date.now() - 30_000).toISOString());
    const t0 = Date.now();
    const r = await planSourceDeliveries("inquiry", new Date());
    const ms = Date.now() - t0;
    const again = await planSourceDeliveries("inquiry", new Date());
    check("28 300台に1通ずつ・まとめて作る・2回目は作らない", r.created === 300 && again.created === 0 && (await prisma.notificationDeliveryRef.count()) === 300, { r, again, ms });
  }

  // ---- 29. 顔ぶれを求めたあとに初めて端末を結び付けた人がいたら、見つけ済みにせず求め直す ----
  await reset();
  {
    const first = await user({ notify: true });
    await sub(first, EP("nc-1"), new Date(Date.now() - 3600_000));
    await prisma.notificationSourceCursor.update({ where: { source: "inquiry" }, data: { cursorT: new Date(Date.now() - 60_000), cursorId: "00000000-0000-0000-0000-000000000000" } });
    await prisma.$executeRawUnsafe(`INSERT INTO dm_inquiries (id, draft_id, name, phone, submitted_at) VALUES ($1::uuid, $2::uuid, 'x', 'x', $3::timestamptz AT TIME ZONE 'UTC')`, randomUUID(), randomUUID(), new Date(Date.now() - 30_000).toISOString());
    const { loadSourceRecipients } = await import("@/lib/push/deliveries/plan");
    const stale = await loadSourceRecipients("inquiry");
    const late = await user({ notify: true });
    await sub(late, EP("nc-2"), new Date(Date.now() - 1000));
    const r1 = await planSourceDeliveries("inquiry", new Date(), stale!);
    const sealed = await prisma.notificationSourceEvent.count();
    const r2 = await planSourceDeliveries("inquiry", new Date());
    const subs = await prisma.notificationDeliveryRef.findMany({ select: { subscriptionId: true } });
    check("29 あとから端末を結び付けた人がいたら一度見送り、求め直して2人とも届く", r1.created === 0 && r1.more && sealed === 0 && r2.created === 2 && subs.length === 2, { r1, sealed, r2, n: subs.length });
  }

  // ---- 30. 読む位置が進まないままでも、読み直しの範囲にある出来事の印は消さない(二重に知らせない) ----
  await reset();
  {
    const on = await user({ notify: true });
    await sub(on, EP("quiet"), new Date(Date.now() - 40 * 86400_000));
    const cur = new Date(Date.now() - 31 * 86400_000);
    await prisma.notificationSourceCursor.update({ where: { source: "inquiry" }, data: { cursorT: cur, cursorId: "00000000-0000-0000-0000-000000000000" } });
    const inside = randomUUID();
    const outside = randomUUID();
    await prisma.$executeRawUnsafe(`INSERT INTO dm_inquiries (id, draft_id, name, phone, submitted_at) VALUES ($1::uuid, $2::uuid, 'x', 'x', $3::timestamptz AT TIME ZONE 'UTC')`, inside, randomUUID(), new Date(cur.getTime() - 60_000).toISOString());
    await prisma.$executeRawUnsafe(`INSERT INTO dm_inquiries (id, draft_id, name, phone, submitted_at) VALUES ($1::uuid, $2::uuid, 'x', 'x', $3::timestamptz AT TIME ZONE 'UTC')`, outside, randomUUID(), new Date(cur.getTime() - 3600_000).toISOString());
    await prisma.notificationSourceEvent.createMany({
      data: [inside, outside].map((eventId) => ({ source: "inquiry", eventId, firstSeenAt: new Date(cur.getTime()) })),
    });
    f = fakeSender();
    await runPushNotifications(new Date(), f.sender);
    const left = (await prisma.notificationSourceEvent.findMany({ select: { eventId: true } })).map((x) => x.eventId);
    check("30 読み直しの範囲にある印は残し(二重に知らせない)、範囲の外の古い印だけ消す", left.includes(inside) && !left.includes(outside) && f.sent.length === 0, { left, sent: f.sent.length });
  }

  // ---- 31. 次回対応が多い人は1回2,000件までに分けて作る(作り済みは除いて続きから) ----
  await reset();
  {
    const u = await user();
    const p = await property(u);
    await prisma.$executeRawUnsafe(
      `INSERT INTO next_actions (id, property_id, assigned_to, scheduled_at, content, created_by, updated_at)
       SELECT gen_random_uuid(), $1::uuid, $2::uuid, $3::date, 'x', $2::uuid, now() FROM generate_series(1, 2500)`,
      p, u, D_TODAY,
    );
    await sub(u, EP("many-na"), JST(`${D_BOUND}T00:00:00`));
    await planNextActionDeliveries(NOW);
    const r1 = await prisma.notificationDeliveryRef.count();
    await planNextActionDeliveries(NOW);
    const r2 = await prisma.notificationDeliveryRef.count();
    await planNextActionDeliveries(NOW);
    const r3 = await prisma.notificationDeliveryRef.count();
    check("31 次回対応2,500件は1回目2,000・2回目で残り500・3回目は増えない", r1 === 2000 && r2 === 2500 && r3 === 2500, { r1, r2, r3 });
  }

  // ---- 32. 古い申込の知らせが溜まっていても、次回対応の知らせにも同じ回で番が回る ----
  await reset();
  {
    const on = await user({ notify: true });
    const p = await property(on);
    await action(p, on, D_TODAY);
    await sub(on, EP("mix"), JST(`${D_BOUND}T00:00:00`));
    const s2 = await prisma.pushSubscription.findFirstOrThrow({ where: { userId: on } });
    await prisma.notificationDelivery.createMany({
      data: Array.from({ length: 250 }, () => ({ id: randomUUID(), userId: on, subscriptionId: s2.id, bindingId: s2.bindingId, kind: "inquiry_new", scheduledFor: new Date(NOW.getTime() - 3600_000) })),
    });
    await planNextActionDeliveries(NOW);
    f = fakeSender();
    await sendDueDeliveries(NOW, f.sender);
    const na = await prisma.notificationDelivery.findFirstOrThrow({ where: { kind: "next_action" } });
    check("32 古い申込の溜まりがあっても次回対応は同じ回で送る", na.status === "sent", na.status);
  }

  // ---- 33. 1件の申込でも送り先の端末が多ければ、2,000台ずつに分け、作り終えてから見つけ済みにする ----
  await reset();
  {
    const on = await user({ notify: true });
    await prisma.pushSubscription.createMany({
      data: Array.from({ length: 2500 }, (_, i) => ({
        userId: on, endpoint: EP(`inq-many-${i}`), ...KEYS, deviceScope: "personal", boundAt: new Date(Date.now() - 3600_000),
        bindingId: randomUUID(), expiresAt: new Date(Date.now() + 86400_000),
      })),
    });
    await prisma.notificationSourceCursor.update({ where: { source: "inquiry" }, data: { cursorT: new Date(Date.now() - 60_000), cursorId: "00000000-0000-0000-0000-000000000000" } });
    await prisma.$executeRawUnsafe(`INSERT INTO dm_inquiries (id, draft_id, name, phone, submitted_at) VALUES ($1::uuid, $2::uuid, 'x', 'x', $3::timestamptz AT TIME ZONE 'UTC')`, randomUUID(), randomUUID(), new Date(Date.now() - 30_000).toISOString());
    const r1 = await planSourceDeliveries("inquiry", new Date());
    const refs1 = await prisma.notificationDeliveryRef.count();
    const sealed1 = await prisma.notificationSourceEvent.count();
    const r2 = await planSourceDeliveries("inquiry", new Date());
    const refs2 = await prisma.notificationDeliveryRef.count();
    const sealed2 = await prisma.notificationSourceEvent.count();
    check("33 1件で2,500台でも1回目2,000台・2回目で残り500台(見つけ済みは最初に・控えから続ける)", refs1 === 2000 && sealed1 === 1 && r1.more && refs2 === 2500 && sealed2 === 1, { r1, refs1, sealed1, r2, refs2, sealed2 });
  }

  // ---- 34. 見つけた時点の顔ぶれのまま続ける(途中で結び付いた端末には、その出来事を送らない) ----
  await reset();
  {
    const on = await user({ notify: true });
    await prisma.pushSubscription.createMany({
      data: Array.from({ length: 2100 }, (_, i) => ({
        userId: on, endpoint: EP(`cohort-${i}`), ...KEYS, deviceScope: "personal", boundAt: new Date(Date.now() - 3600_000),
        bindingId: randomUUID(), expiresAt: new Date(Date.now() + 86400_000),
      })),
    });
    await prisma.notificationSourceCursor.update({ where: { source: "inquiry" }, data: { cursorT: new Date(Date.now() - 60_000), cursorId: "00000000-0000-0000-0000-000000000000" } });
    await prisma.$executeRawUnsafe(`INSERT INTO dm_inquiries (id, draft_id, name, phone, submitted_at) VALUES ($1::uuid, $2::uuid, 'x', 'x', $3::timestamptz AT TIME ZONE 'UTC')`, randomUUID(), randomUUID(), new Date(Date.now() - 30_000).toISOString());
    await planSourceDeliveries("inquiry", new Date());
    const lateSub = await sub(on, EP("cohort-late"), new Date());
    await planSourceDeliveries("inquiry", new Date(Date.now() + 1000));
    const refs = await prisma.notificationDeliveryRef.count();
    const toLate = await prisma.notificationDeliveryRef.count({ where: { subscriptionId: lateSub.id } });
    check("34 途中で結び付いた端末には、見つけた後の出来事を送らない(2,100台だけ)", refs === 2100 && toLate === 0, { refs, toLate });
  }

  // ---- 35. まだ送っていない1通に足すのは500件まで(超えたら新しい1通) ----
  await reset();
  {
    const on = await user({ notify: true });
    await sub(on, EP("cap"), new Date(Date.now() - 3600_000));
    await prisma.notificationSourceCursor.update({ where: { source: "inquiry" }, data: { cursorT: new Date(Date.now() - 120_000), cursorId: "00000000-0000-0000-0000-000000000000" } });
    await prisma.$executeRawUnsafe(
      `INSERT INTO dm_inquiries (id, draft_id, name, phone, submitted_at)
       SELECT gen_random_uuid(), gen_random_uuid(), 'x', 'x', ((now() - interval '60 seconds') AT TIME ZONE 'UTC') + (g * interval '1 millisecond') FROM generate_series(1, 60) g`,
    );
    for (let i = 0; i < 12; i++) await planSourceDeliveries("inquiry", new Date());
    await prisma.$executeRawUnsafe(
      `INSERT INTO dm_inquiries (id, draft_id, name, phone, submitted_at)
       SELECT gen_random_uuid(), gen_random_uuid(), 'x', 'x', ((now() - interval '50 seconds') AT TIME ZONE 'UTC') + (g * interval '1 millisecond') FROM generate_series(1, 540) g`,
    );
    for (let i = 0; i < 12; i++) await planSourceDeliveries("inquiry", new Date());
    const sizes = (await prisma.notificationDelivery.findMany({ where: { kind: "inquiry_new" }, select: { _count: { select: { refs: true } } } })).map((d) => d._count.refs).sort((a, b) => b - a);
    check("35 1通は500件まで・超えた分は新しい1通(600件→500+100)", JSON.stringify(sizes) === JSON.stringify([500, 100]), sizes);
  }

  // ---- 17. カーソルの行が無い(migration 前)なら失敗で終わり、送らない ----
  await reset();
  {
    await prisma.$executeRawUnsafe(`DELETE FROM notification_source_cursors WHERE source = 'inquiry'`);
    f = fakeSender();
    const err = await runPushNotifications(new Date(), f.sender).then(() => null, (e: Error) => e.message);
    check("17 カーソルが無ければ失敗で終わる", err === "notification_source_cursor_missing" && f.sent.length === 0, err);
  }

}

describe.skipIf(!process.env.PUSH_DB_TEST_URL)("通知 段階4b: 記録づくりと送信(本物の Postgres)", () => {
  it("すべての確認項目が通る", async () => {
    try {
      await main();
    } finally {
      await prisma.$disconnect();
    }
    expect(failures).toEqual([]);
  }, 600_000);
});
