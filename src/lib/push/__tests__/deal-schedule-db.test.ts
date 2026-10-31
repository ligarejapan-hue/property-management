/**
 * 決済までの段取り: 作成・見回り・朝の通知(本物の Postgres)
 *
 * ⚠使い捨ての DB が要る(`PUSH_DB_TEST_URL`=全 migration を流した空の DB)。無ければ飛ばす。
 *   CI では db-integration の仕事で流す。⚠この DB の中身は消す。共用の dev DB を指定しないこと。
 */
import { describe, it, expect, vi } from "vitest";

vi.hoisted(() => {
  const url = process.env.PUSH_DB_TEST_URL;
  if (url) {
    process.env.DATABASE_URL = url;
    process.env.NEXT_PUBLIC_USE_MOCK = "true";
    process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || "db-test-secret";
  }
});

// 取引の閲覧がある人。no-perm は権限なしの確かめ用。
const noPermUsers = vi.hoisted(() => new Set<string>());
vi.mock("@/lib/api-helpers", async () => {
  const { resolveOwnerDisplayConfig } = await import("@/lib/permissions");
  const perms = [{ resource: "deal", action: "read", granted: true }, { resource: "property", action: "read", granted: true }];
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
    getUserPermissions: async (id: string) => (noPermUsers.has(id) ? [] : perms),
    getOwnerDisplayConfig: async () => resolveOwnerDisplayConfig(perms),
  };
});

import { randomUUID } from "crypto";
import prisma from "@/lib/prisma";
import { addYmdDays } from "@/lib/deals/schedule";
import { sweepDealSchedules, syncDealSchedule, withDealLock } from "@/lib/deals/schedule-sync";
import { runPushNotifications } from "@/lib/push/deliveries/run";
import type { PushSender } from "@/lib/push/deliveries/web-push-sender";
import type { PushPayload } from "@/lib/push/deliveries/rules";

const failures: string[] = [];
function check(name: string, cond: boolean, extra?: unknown) {
  if (!cond) failures.push(`${name}${extra !== undefined ? " " + JSON.stringify(extra) : ""}`);
}
function fakeSender() {
  const sent: PushPayload[] = [];
  const sender: PushSender = async (_t, payload) => {
    sent.push(payload);
    return { ok: true };
  };
  return { sent, sender };
}
const KEYS = { p256dh: "BOKP86iRrT4RDIC4MTCWRE1ILIQ5FhmBF1SAklaX0SRrzNrt9KdHvCuq-YF-slJ0UJn1Koqh0bjqPtO9mUWxjms", auth: "eh3yijm3LYC3dTqUVPZFbw" };

async function reset() {
  noPermUsers.clear();
  await prisma.$executeRawUnsafe(`TRUNCATE notification_delivery_refs, notification_deliveries, notification_source_events, push_subscriptions, deal_schedule_items, deals, properties, users CASCADE`);
  for (const source of ["inquiry", "registry_job"]) {
    await prisma.notificationSourceCursor.upsert({
      where: { source },
      create: { source, cursorT: new Date(), cursorId: "00000000-0000-0000-0000-000000000000", updatedAt: new Date() },
      update: { cursorT: new Date() },
    });
  }
}
async function user() {
  const id = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (id, email, name, password_hash, updated_at, role, is_active) VALUES ($1::uuid, $2, 'x', 'x', now(), 'admin'::"Role", true)`,
    id, `${id}@x.test`,
  );
  await prisma.pushSubscription.create({
    data: { userId: id, endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, ...KEYS, deviceScope: "personal", boundAt: new Date("2020-01-01T00:00:00Z"), bindingId: randomUUID(), expiresAt: new Date(Date.now() + 365 * 86_400_000) },
  });
  return id;
}
let seq = 0;
async function deal(assigneeId: string, o: { contract?: string | null; settlement?: string | null; status?: string; kind?: string; propertyId?: string } = {}) {
  seq += 1;
  const created = await prisma.deal.create({
    data: {
      dealNo: `9999-${String(seq).padStart(4, "0")}`, name: "x", businessType: "brokerage", tradeSide: "seller", propertyKind: o.kind ?? "unit",
      status: o.status ?? "contracted", assigneeId, createdById: assigneeId, propertyId: o.propertyId ?? null,
      contractAt: o.contract ? new Date(`${o.contract}T10:00:00+09:00`) : null,
      settlementAt: o.settlement ? new Date(`${o.settlement}T10:00:00+09:00`) : null,
    },
    select: { id: true },
  });
  return created.id;
}
const at = (ymd: string, hm: string) => new Date(`${ymd}T${hm}:00.000+09:00`);
const itemsOf = (dealId: string) => prisma.dealScheduleItem.findMany({ where: { dealId } });
const ymd = (d: Date) => d.toISOString().slice(0, 10);
/**
 * ⚠基準の日は「次の月曜」。遠い未来の日付にすると、古い記録の片付け(作ってから30日)が今作った送信記録まで
 * 消してしまい、同じ通知が2回出たように見える。時刻は今より後なら本物の時計より優先される。
 */
function nextMonday(): string {
  const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
  const day = new Date(`${today}T00:00:00.000Z`).getUTCDay();
  return addYmdDays(today, day === 0 ? 1 : 8 - day);
}

async function main() {
  const MON = nextMonday();
  const D = (n: number) => addYmdDays(MON, n);

  // ---- 1. 既存の取引: 過ぎた項目は導入前。導入の朝に期限超過が届かない ----
  await reset();
  {
    const a = await user();
    const d = await deal(a, { contract: D(-35), settlement: D(7) });
    await syncDealSchedule(d, { now: at(MON, "08:00") });
    const items = await itemsOf(d);
    const by = (k: string) => items.find((i) => i.templateKey === k);
    check("1 契約+1 は導入前", by("c_scrivener")?.preIntroduction === true, by("c_scrivener"));
    check("1 決-7=今日は導入前にしない", by("s_statement")?.preIntroduction === false && ymd(by("s_statement")!.dueDate) === MON, by("s_statement"));
    check("1 手入力物件=担保を判定できず印を付けて出す", by("c_mortgage")?.mortgageUnknown === true);
    check("1 区分の項目がある・買取再販の項目が無い", !!by("s_management_report") && !by("s_loan"));
    check("1 担当は取引の担当", by("s_statement")?.assigneeId === a);

    const before9 = fakeSender();
    await runPushNotifications(at(MON, "08:59"), before9.sender);
    check("1 9時前は送らない", before9.sent.length === 0, before9.sent);

    const morning = fakeSender();
    await runPushNotifications(at(MON, "09:05"), morning.sender);
    check("1 朝は今日の分だけ1通(導入前は入らない)", morning.sent.length === 1 && morning.sent[0].body === "今日の段取りが1件あります", morning.sent);
    check("1 中身に作業名を入れない", !JSON.stringify(morning.sent).includes("精算書"));

    const again = fakeSender();
    await runPushNotifications(at(MON, "09:07"), again.sender);
    check("1 同じ朝に2回送らない", again.sent.length === 0, again.sent);

    const next = fakeSender();
    await runPushNotifications(at(D(1), "09:05"), next.sender);
    check("1 翌朝は期限超過と明日の分", next.sent.length === 1 && next.sent[0].body === "明日の段取りが1件、期限超過が1件あります", next.sent);

    const third = fakeSender();
    await runPushNotifications(at(D(1), "09:30"), third.sender);
    check("1 同じ日の2回目は送らない", third.sent.length === 0, third.sent);

    await prisma.dealScheduleItem.updateMany({ where: { dealId: d, templateKey: "s_statement" }, data: { completedAt: new Date() } });
    const after = fakeSender();
    await runPushNotifications(at(D(2), "09:05"), after.sender);
    check("1 完了すれば期限超過から外れる", after.sent.length === 1 && after.sent[0].body === "今日の段取りが1件あります", after.sent);

    const pre = await prisma.dealScheduleItem.count({ where: { dealId: d, preIntroduction: true, completedAt: null } });
    check("1 導入前の項目は残っている", pre > 0, pre);
  }

  // ---- 2. 付け直し: 完了済み・手で直した項目は動かない ----
  await reset();
  {
    const a = await user();
    const d = await deal(a, { contract: MON, settlement: D(65) });
    const now = at(MON, "10:00");
    await syncDealSchedule(d, { now });
    await prisma.dealScheduleItem.updateMany({ where: { dealId: d, templateKey: "s_final" }, data: { completedAt: now } });
    await prisma.dealScheduleItem.updateMany({ where: { dealId: d, templateKey: "s_tax" }, data: { dueDate: new Date(`${D(26)}T00:00:00Z`), dueManual: true } });
    const before = await itemsOf(d);
    await syncDealSchedule(d, { now });
    const same = await itemsOf(d);
    check("2 変わらなければ行数も期限も同じ", same.length === before.length && same.every((s) => ymd(s.dueDate) === ymd(before.find((b) => b.id === s.id)!.dueDate)));
    await prisma.deal.update({ where: { id: d }, data: { settlementAt: at(D(72), "10:00") } });
    await syncDealSchedule(d, { now });
    const moved = await itemsOf(d);
    const by = (k: string) => moved.find((i) => i.templateKey === k)!;
    check("2 未完了は付け直す(決-7・平日のまま)", ymd(by("s_statement").dueDate) === D(65), ymd(by("s_statement").dueDate));
    check("2 完了済みは動かない", ymd(by("s_final").dueDate) === ymd(before.find((b) => b.templateKey === "s_final")!.dueDate));
    check("2 手で直した期限は動かない", ymd(by("s_tax").dueDate) === D(26));
    // 土曜が決済のとき: 決+1=日→月、決当日=土のまま、決-7=土→金。
    await prisma.deal.update({ where: { id: d }, data: { settlementAt: at(D(75), "10:00") } });
    await syncDealSchedule(d, { now });
    const sat = await itemsOf(d);
    const s = (k: string) => ymd(sat.find((i) => i.templateKey === k)!.dueDate);
    check("2 決+1 が日曜なら月曜", s("s_mgmt_notify") === D(77), s("s_mgmt_notify"));
    check("2 決当日は寄せない", s("s_settle") === D(75), s("s_settle"));
    check("2 決-7 が土曜なら金曜", s("s_statement") === D(67), s("s_statement"));
    await prisma.deal.update({ where: { id: d }, data: { propertyKind: "house" } });
    await syncDealSchedule(d, { now });
    const house = await itemsOf(d);
    check("2 条件が外れた項目は消えずに対象外", house.length === sat.length && house.find((i) => i.templateKey === "s_mgmt_notify")?.excludedAt !== null);
  }

  // ---- 2b. 同期と手の変更が重なっても、手で直した期限を上書きしない ----
  await reset();
  {
    const a = await user();
    const d = await deal(a, { contract: MON, settlement: D(65) });
    const now = at(MON, "10:00");
    await syncDealSchedule(d, { now });
    await prisma.deal.update({ where: { id: d }, data: { settlementAt: at(D(72), "10:00") } });
    let release = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    let locked = () => {};
    const hasLock = new Promise<void>((r) => { locked = r; });
    const manual = withDealLock(d, async (tx) => {
      locked();
      await gate;
      await tx.dealScheduleItem.updateMany({ where: { dealId: d, templateKey: "s_statement" }, data: { dueDate: new Date(`${D(26)}T00:00:00Z`), dueManual: true } });
    });
    await hasLock;
    const sync = syncDealSchedule(d, { now });
    await new Promise((r) => setTimeout(r, 300));
    release();
    await Promise.all([manual, sync]);
    const row = (await itemsOf(d)).find((i) => i.templateKey === "s_statement");
    check("2b 手で直した期限が残る", ymd(row!.dueDate) === D(26) && row!.dueManual === true, row);
    const other = (await itemsOf(d)).find((i) => i.templateKey === "s_keys_docs");
    check("2b ほかの項目は付け直される", ymd(other!.dueDate) === D(71), other && ymd(other.dueDate));
  }

  // ---- 3. 自動の完了と見回り ----
  await reset();
  {
    const a = await user();
    const d = await deal(a, { contract: MON, settlement: D(65) });
    await syncDealSchedule(d, { now: at(MON, "10:00") });
    await syncDealSchedule(d, { now: at(MON, "10:00"), event: { issuedDocType: "settlement_statement" } });
    const it1 = (await itemsOf(d)).find((i) => i.templateKey === "s_statement");
    check("3 精算書の発行で完了", !!it1?.completedAt && it1.autoCompleted === true);
    await prisma.dealScheduleItem.update({ where: { id: it1!.id }, data: { completedAt: null, autoCompleted: false } });
    await syncDealSchedule(d, { now: at(MON, "11:00") });
    check("3 取り消した完了は、次の同期で戻らない", (await itemsOf(d)).find((i) => i.templateKey === "s_statement")?.completedAt === null);

    const future = await deal(a, { settlement: D(37) });
    const past = await deal(a, { settlement: D(-6) });
    const cancelled = await deal(a, { settlement: D(37), status: "cancelled" });
    check("3 朝6時より前は見回らない", (await sweepDealSchedules(at(MON, "05:59"))) === 0);
    await sweepDealSchedules(at(MON, "06:01"));
    check("3 決済日が今日以降の取引に作る", (await itemsOf(future)).length > 0);
    check("3 決済日を過ぎた取引には作らない", (await itemsOf(past)).length === 0);
    check("3 中止の取引には作らない", (await itemsOf(cancelled)).length === 0);
    const facts = (await prisma.deal.findUnique({ where: { id: future }, select: { scheduleFacts: true } }))?.scheduleFacts as { sweptOn?: string };
    check("3 見回りの印", facts.sweptOn === MON, facts);
    const version = (await prisma.deal.findUnique({ where: { id: future }, select: { version: true } }))?.version;
    check("3 見回りで版の番号を進めない", version === 1, version);
    check("3 同じ日は2回目を見回らない", (await sweepDealSchedules(at(MON, "07:00"))) === 0);
  }

  // ---- 4. 送らない人・取引 ----
  await reset();
  {
    const a = await user();
    const d = await deal(a, { contract: MON, settlement: D(7) });
    await syncDealSchedule(d, { now: at(MON, "08:00") });
    await prisma.deal.update({ where: { id: d }, data: { status: "cancelled" } });
    const c = fakeSender();
    await runPushNotifications(at(MON, "09:05"), c.sender);
    check("4 中止の取引は送らない", c.sent.length === 0, c.sent);

    const b = await user();
    const e = await deal(b, { contract: MON, settlement: D(7) });
    await syncDealSchedule(e, { now: at(MON, "08:00") });
    noPermUsers.add(b);
    const n = fakeSender();
    await runPushNotifications(at(MON, "09:06"), n.sender);
    check("4 取引の権限が無い人には送らない", n.sent.length === 0, n.sent);
  }
}

describe.skipIf(!process.env.PUSH_DB_TEST_URL)("決済までの段取り(本物の Postgres)", () => {
  it("すべての確認項目が通る", async () => {
    try {
      await main();
    } finally {
      await prisma.$disconnect();
    }
    expect(failures).toEqual([]);
  }, 600_000);
});
