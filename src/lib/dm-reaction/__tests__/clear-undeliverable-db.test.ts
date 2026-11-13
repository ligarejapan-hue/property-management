/**
 * 宛先不明の解除(本物の Postgres・2026-11-13 発注者決定)
 *
 * 確かめること: 住所を替えた所有者の「宛先不明」を解除すると、
 *  - 宛名CSV・売却DMの除外(findTerminalExclusions)から外れる
 *  - 物件一覧の「再送候補」の条件(buildResendCandidateWhere)に戻る
 *  - 物件の「宛先不明」の印が外れ、DM 可否が「送らない」→「送付可」に戻る(変更履歴つき)
 * ⚠拒否・共有でまとめて送った記録・物件の住所あて・裏に拒否が控える記録は解除されない。
 * ⚠反響を書き換えたら印が消える(新しい住所でまた宛先不明になったら、また外れる)。
 * ⚠`PUSH_DB_TEST_URL`(全 migration を流した使い捨ての DB)があるときだけ動く。中身は消す。
 *   手元: 空の DB に `DATABASE_URL=<DB> npx prisma migrate deploy` →
 *   `PUSH_DB_TEST_URL=<DB> npx vitest run --no-file-parallelism <このファイル>`
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  const url = process.env.PUSH_DB_TEST_URL;
  if (url) {
    process.env.DATABASE_URL = url;
    process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || "db-test-secret";
  }
});

// property-record-guard が api-helpers(next-auth → next/server)を引く。node の環境では解決できない
// ので、ここで使う形(ApiError)だけの作り物にする(registry-owner-check-db.test.ts と同じ)。
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
import prisma from "@/lib/prisma";
import { findTerminalExclusions } from "@/lib/dm-batch/terminal-exclusion";
import { buildResendCandidateWhere } from "@/lib/dm-resend/candidacy";
import { clearOwnerUndeliverable, loadUndeliverableSummaries } from "@/lib/dm-reaction/clear-undeliverable";
import { clearedFieldsOnReactionWrite } from "@/lib/dm-reaction/core";
import { countActiveUndeliverable } from "@/lib/dm-reaction/undeliverable-flag";

const USER = "11111111-1111-4111-8111-111111111111";
const OFFICE = { id: USER, role: "office_staff" };
const OLD = new Date("2020-01-01T00:00:00.000Z");
const NOW = new Date("2026-11-13T03:00:00.000Z");

async function owner(name: string): Promise<string> {
  return (await prisma.owner.create({ data: { name, address: "東京都見本区1-1-1" }, select: { id: true } })).id;
}
/** 宛先不明が付いた直後の物件の形(印あり・送らない)。 */
async function property(over: { dmStatus?: string; flagged?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO properties (id, property_type, address, registry_status, dm_status, dm_undeliverable_at, created_by, updated_at)
     VALUES ($1::uuid, 'land', 'x', 'obtained', $2::"DmStatus", $3, $4::uuid, now())`,
    id,
    over.dmStatus ?? "no_send",
    over.flagged === false ? null : OLD,
    USER,
  );
  return id;
}
async function link(propertyId: string, ownerId: string) {
  await prisma.propertyOwner.create({ data: { propertyId, ownerId } });
}
async function log(
  propertyId: string,
  ownerId: string | null,
  over: { status?: string; dmType?: string | null; coOwners?: string[]; shadow?: unknown } = {},
): Promise<string> {
  const row = await prisma.propertyDmLog.create({
    data: {
      propertyId,
      ownerId,
      sentAt: OLD,
      sentBy: USER,
      dmType: over.dmType === undefined ? "owner_address" : over.dmType,
      reactionStatus: over.status ?? "undeliverable",
      reactedAt: OLD,
      reactionSource: "manual",
      ...(over.shadow ? { manualReactionShadow: over.shadow as never } : {}),
      ...(over.coOwners ? { logOwners: { create: over.coOwners.map((id) => ({ ownerId: id })) } } : {}),
    },
    select: { id: true },
  });
  return row.id;
}
const excluded = async (ownerIds: string[], propertyIds: string[] = []) =>
  [...(await findTerminalExclusions(prisma as never, ownerIds, propertyIds)).ownerIds].sort();
const resendCandidates = async () =>
  (
    await prisma.property.findMany({
      where: { AND: buildResendCandidateWhere(NOW, 90) as never },
      select: { id: true },
    })
  ).map((p) => p.id);
const clear = (ownerId: string, session = OFFICE) =>
  prisma.$transaction((tx) => clearOwnerUndeliverable(tx, { ownerId, session, now: NOW }));

describe.skipIf(!process.env.PUSH_DB_TEST_URL)("宛先不明の解除(本物の Postgres)", () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      `TRUNCATE change_logs, property_dm_log_owners, property_dm_logs, dm_recipient_drafts, property_owners, owners, properties, users CASCADE`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (id, email, name, password_hash, updated_at, role, is_active) VALUES ($1::uuid, $2, 'x', 'x', now(), 'admin'::"Role", true)`,
      USER,
      "clear-undeliverable-db@example.com",
    );
  });

  it("★解除すると、除外から外れ、再送の候補に戻り、物件の印と DM 可否が戻る", async () => {
    const o = await owner("山田太郎");
    const p = await property();
    await link(p, o);
    const l = await log(p, o);

    expect(await excluded([o])).toEqual([o]);
    expect(await resendCandidates()).toEqual([]);
    expect((await loadUndeliverableSummaries(prisma, [o], OFFICE)).get(o)).toEqual({ clearable: 1, shared: 0, other: 0 });

    const r = await clear(o);
    expect(r).toMatchObject({ cleared: 1, sharedSkipped: 0, otherSkipped: 0, flagsCleared: 1, dmStatusRestored: 1 });

    // 記録は宛先不明のまま残り、解除の印が付く
    const after = await prisma.propertyDmLog.findUniqueOrThrow({ where: { id: l } });
    expect(after.reactionStatus).toBe("undeliverable");
    expect(after.undeliverableClearedAt?.toISOString()).toBe(NOW.toISOString());
    expect(after.undeliverableClearedBy).toBe(USER);
    // 除外から外れる・再送の候補に戻る
    expect(await excluded([o])).toEqual([]);
    expect(await resendCandidates()).toEqual([p]);
    // 物件の印が外れ、DM 可否が送付可に・version が進み・変更履歴が残る
    const prop = await prisma.property.findUniqueOrThrow({ where: { id: p } });
    expect(prop.dmUndeliverableAt).toBeNull();
    expect(prop.dmStatus).toBe("send");
    expect(prop.version).toBe(2);
    const cl = await prisma.changeLog.findMany({ where: { targetId: p, fieldName: "dmStatus" } });
    expect(cl.map((c) => [c.oldValue, c.newValue])).toEqual([["no_send", "send"]]);
    // 2回目は何もしない
    expect(await clear(o)).toMatchObject({ cleared: 0, flagsCleared: 0, dmStatusRestored: 0 });
    expect((await loadUndeliverableSummaries(prisma, [o], OFFICE)).has(o)).toBe(false);
  });

  it("⚠拒否は解除されない(解除の印が付いていても、除外されたまま)", async () => {
    const o = await owner("拒否の人");
    const p = await property({ flagged: false, dmStatus: "send" });
    await link(p, o);
    const l = await log(p, o, { status: "refused" });
    expect(await clear(o)).toMatchObject({ cleared: 0 });
    // 念のため: 拒否の行に印を無理やり付けても、除外は解けない
    await prisma.propertyDmLog.update({ where: { id: l }, data: { undeliverableClearedAt: NOW } });
    expect(await excluded([o])).toEqual([o]);
    expect(await resendCandidates()).toEqual([]);
  });

  it("⚠共有でまとめて送った記録・物件の住所あて・裏に拒否が控える記録は解除しない", async () => {
    const a = await owner("共有A");
    const b = await owner("共有B");
    const p = await property();
    await link(p, a);
    await link(p, b);
    await log(p, a, { coOwners: [a, b] }); // 共有でまとめて送った
    await log(p, a, { dmType: "property_address" }); // 物件の住所あて
    await log(p, a, { shadow: { status: "refused", reactedAt: null, note: null } }); // 裏に拒否

    expect((await loadUndeliverableSummaries(prisma, [a], OFFICE)).get(a)).toEqual({ clearable: 0, shared: 1, other: 2 });
    const r = await clear(a);
    expect(r).toMatchObject({ cleared: 0, sharedSkipped: 1, otherSkipped: 2, flagsCleared: 0, dmStatusRestored: 0 });
    expect(await excluded([a, b])).toEqual([a, b].sort());
    const prop = await prisma.property.findUniqueOrThrow({ where: { id: p } });
    expect(prop.dmStatus).toBe("no_send");
    expect(prop.dmUndeliverableAt).not.toBeNull();
  });

  it("解除できる記録と共有の記録が両方あるときは、解除できる分だけ解除する(所有者はまだ除外・物件の印も残る)", async () => {
    const a = await owner("共有A");
    const b = await owner("共有B");
    const p = await property();
    await link(p, a);
    await link(p, b);
    await log(p, a);
    await log(p, a, { coOwners: [a, b] });
    const r = await clear(a);
    expect(r).toMatchObject({ cleared: 1, sharedSkipped: 1, flagsCleared: 0, dmStatusRestored: 0 });
    // 共有の記録が残るので、A も(同じ手紙に入っていた B も)除外されたまま
    expect(await excluded([a])).toEqual([a, b].sort());
    expect(await countActiveUndeliverable(prisma, p)).toBe(1);
  });

  it("⚠「宛先不明」の印が無い物件の「送らない」は人の判断=戻さない", async () => {
    const o = await owner("山田太郎");
    const p = await property({ flagged: false, dmStatus: "no_send" });
    await link(p, o);
    await log(p, o);
    const r = await clear(o);
    expect(r).toMatchObject({ cleared: 1, flagsCleared: 0, dmStatusRestored: 0 });
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p } })).dmStatus).toBe("no_send");
    expect(await excluded([o])).toEqual([]);
  });

  it("ほかの物件にも宛先不明がある所有者は、物件ごとに印と DM 可否を戻す", async () => {
    const o = await owner("山田太郎");
    const p1 = await property();
    const p2 = await property({ dmStatus: "hold" });
    await link(p1, o);
    await link(p2, o);
    await log(p1, o);
    await log(p2, o);
    const r = await clear(o);
    expect(r).toMatchObject({ cleared: 2, flagsCleared: 2, dmStatusRestored: 1 });
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p1 } })).dmStatus).toBe("send");
    // 「送らない」でなかった物件は、印だけ外す(DM 可否・version は触らない)
    const two = await prisma.property.findUniqueOrThrow({ where: { id: p2 } });
    expect([two.dmStatus, two.dmUndeliverableAt, two.version]).toEqual(["hold", null, 1]);
  });

  it("⚠現場担当は、担当する物件の記録だけ解除する", async () => {
    const field = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (id, email, name, password_hash, updated_at, role, is_active) VALUES ($1::uuid, $2, 'f', 'x', now(), 'field_staff'::"Role", true)`,
      field,
      "field-db@example.com",
    );
    const o = await owner("山田太郎");
    const mine = await property();
    const others = await property();
    await prisma.property.update({ where: { id: mine }, data: { assignedTo: field } });
    await link(mine, o);
    await link(others, o);
    await log(mine, o);
    await log(others, o);
    const r = await clear(o, { id: field, role: "field_staff" });
    expect(r).toMatchObject({ cleared: 1, otherSkipped: 1, flagsCleared: 1 });
    // 担当外の物件は何も変わらない・所有者はまだ除外されたまま
    const untouched = await prisma.property.findUniqueOrThrow({ where: { id: others } });
    expect([untouched.dmStatus, untouched.dmUndeliverableAt === null]).toEqual(["no_send", false]);
    expect(await excluded([o])).toEqual([o]);
  });

  it("⚠反響を書き換えると印が消える: 解除のあと別の反響にして、また宛先不明になったら、また外れる", async () => {
    const o = await owner("山田太郎");
    const p = await property();
    await link(p, o);
    const l = await log(p, o);
    await clear(o);
    expect(await excluded([o])).toEqual([]);
    // 反響の書き手と同じ書き方(宛先不明 → 連絡あり → 宛先不明)
    await prisma.propertyDmLog.update({
      where: { id: l },
      data: { reactionStatus: "replied", ...clearedFieldsOnReactionWrite("undeliverable", "replied") },
    });
    expect((await prisma.propertyDmLog.findUniqueOrThrow({ where: { id: l } })).undeliverableClearedAt).toBeNull();
    await prisma.propertyDmLog.update({
      where: { id: l },
      data: { reactionStatus: "undeliverable", ...clearedFieldsOnReactionWrite("replied", "undeliverable") },
    });
    expect(await excluded([o])).toEqual([o]);
    // 宛先不明のまま日付だけ直す書き方では、印は消えない
    await clear(o);
    await prisma.propertyDmLog.update({
      where: { id: l },
      data: { reactedAt: NOW, ...clearedFieldsOnReactionWrite("undeliverable", "undeliverable") },
    });
    expect(await excluded([o])).toEqual([]);
  });

  it("売却DMの記録(宛先の返戻とつながる記録)を解除したら、宛先の返戻は印の数え直しに数えない", async () => {
    const o = await owner("山田太郎");
    const p = await property();
    await link(p, o);
    const draftId = randomUUID();
    const l = await log(p, o, { dmType: null });
    await prisma.propertyDmLog.update({ where: { id: l }, data: { draftId } });
    // 宛先(送付済み・返戻)を作る代わりに、数え方だけを確かめる(宛先の表は必須列が多いため)
    expect(await countActiveUndeliverable(prisma, p)).toBe(1);
    await clear(o);
    expect(await countActiveUndeliverable(prisma, p)).toBe(0);
  });
});
