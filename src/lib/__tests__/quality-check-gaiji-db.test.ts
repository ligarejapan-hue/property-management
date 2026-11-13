/**
 * 物件データエラー確認の「所有者に読めない字（外字）」(本物の Postgres・2026-11-13 発注者)
 *
 * 確かめること: 所有者の名前・登記上の住所・現住所のどれかに外字(私用領域の字)がある物件が当たること、
 * 外字の無い物件・外した(保管した)所有者は返さないこと、決まりの where で物件が引けること。
 * ⚠`PUSH_DB_TEST_URL`(全 migration を流した使い捨ての DB)があるときだけ動く。中身は消す。
 *   手元: 空の DB に `DATABASE_URL=<DB> npx prisma migrate deploy` →
 *   `PUSH_DB_TEST_URL=<DB> npx vitest run --no-file-parallelism <このファイル>`
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

vi.hoisted(() => {
  const url = process.env.PUSH_DB_TEST_URL;
  if (url) {
    process.env.DATABASE_URL = url;
    process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || "db-test-secret";
  }
});

import prisma from "@/lib/prisma";
import { loadQualityContext } from "@/lib/quality-check-context";
import { qualityRules, qualityWarningWhere, OWNER_GAIJI_CODE } from "@/lib/quality-check-rules";

const USER = "22222222-2222-4222-8222-222222222222";

async function property(): Promise<string> {
  const id = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO properties (id, property_type, address, registry_status, dm_status, created_by, assigned_to, investigation_confirmed_at, lot_number, updated_at)
     VALUES ($1::uuid, 'land', 'x', 'obtained', 'hold'::"DmStatus", $2::uuid, $2::uuid, now(), '1-1', now())`,
    id, USER,
  );
  return id;
}

async function linkOwner(propertyId: string, data: { name: string; address?: string | null; currentAddress?: string | null; isArchived?: boolean }) {
  const o = await prisma.owner.create({ data, select: { id: true } });
  await prisma.propertyOwner.create({ data: { propertyId, ownerId: o.id } });
}

describe.skipIf(!process.env.PUSH_DB_TEST_URL)("所有者に読めない字（外字）(本物の Postgres)", () => {
  const p: Record<string, string> = {};

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`TRUNCATE property_owners, owners, properties, users CASCADE`);
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (id, email, name, password_hash, updated_at, role, is_active) VALUES ($1::uuid, $2, 'x', 'x', now(), 'admin'::"Role", true)`,
      USER, "quality-gaiji-db@example.com",
    );
    p.name = await property();
    await linkOwner(p.name, { name: "大一郎", address: "東京都架空区見本町1" });
    p.address = await property();
    await linkOwner(p.address, { name: "佐藤一郎", address: "東京都架空区町1" });
    p.current = await property();
    await linkOwner(p.current, { name: "鈴木一郎", address: "東京都架空区見本町1", currentAddress: "神奈川県架空市町2" });
    p.second = await property();
    await linkOwner(p.second, { name: "田中一郎", address: "東京都架空区見本町1" });
    await linkOwner(p.second, { name: "田中花", address: "東京都架空区見本町1" });
    p.plain = await property();
    await linkOwner(p.plain, { name: "山本一郎", address: "東京都架空区見本町1" });
    p.archivedOwner = await property();
    await linkOwner(p.archivedOwner, { name: "保管", address: "東京都架空区見本町1", isArchived: true });
    p.noOwner = await property();
  });

  it("名前・登記上の住所・現住所のどれかに外字がある所有者がつながる物件が当たる(保管した所有者は数えない)", async () => {
    const ctx = await loadQualityContext();
    const rule = qualityRules(ctx).find((r) => r.code === OWNER_GAIJI_CODE)!;
    const hit = await prisma.property.findMany({ where: { isArchived: false, ...rule.where }, select: { id: true } });
    expect(hit.map((r) => r.id).sort()).toEqual([p.name, p.address, p.current, p.second].sort());
    const warn = await prisma.property.findMany({ where: { isArchived: false, ...qualityWarningWhere(ctx) }, select: { id: true } });
    const warnIds = warn.map((r) => r.id);
    expect(warnIds).toContain(p.address);
    expect(warnIds).not.toContain(p.plain);
  });

  it("外字が1つも無ければ空(決まりは何も引かない)", async () => {
    const ctx = { gaijiOwnerIds: [] };
    const rule = qualityRules(ctx).find((r) => r.code === OWNER_GAIJI_CODE)!;
    expect(await prisma.property.count({ where: { isArchived: false, ...rule.where } })).toBe(0);
  });
});
