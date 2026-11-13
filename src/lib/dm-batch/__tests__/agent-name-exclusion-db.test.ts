/**
 * 業者と同じ名前の所有者(本物の Postgres・2026-11-09)
 *
 * 確かめること: 名前のそろえ方の SQL が本物の Postgres で両側に効くこと(全角/半角・空白・㈱/(株)/株式会社・異体字)、
 * 使っていない名簿の業者・空の名前・後株と前株の違いは一致にしないこと、国交省の一覧の行とも照合すること。
 * ⚠`PUSH_DB_TEST_URL`(全 migration を流した使い捨ての DB)があるときだけ動く。中身は消す。
 *   手元: 空の DB に `DATABASE_URL=<DB> npx prisma migrate deploy` →
 *   `PUSH_DB_TEST_URL=<DB> npx vitest run --no-file-parallelism <このファイル>`
 */
import { describe, it, expect, vi, beforeAll } from "vitest";

vi.hoisted(() => {
  const url = process.env.PUSH_DB_TEST_URL;
  if (url) {
    process.env.DATABASE_URL = url;
    process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || "db-test-secret";
  }
});

import prisma from "@/lib/prisma";
import { findAgentNameOwnerIds, findOwnerNameExclusions } from "../agent-name-exclusion";

const USER = "11111111-1111-4111-8111-111111111111";

async function owner(name: string): Promise<string> {
  const o = await prisma.owner.create({ data: { name }, select: { id: true } });
  return o.id;
}

describe.skipIf(!process.env.PUSH_DB_TEST_URL)("業者と同じ名前の所有者(本物の Postgres)", () => {
  const ids: Record<string, string> = {};
  // 異体字の表を広げた分(2026-11-11)。ids とは別にして、上の照合の期待を変えない。
  const variantIds: Record<string, string> = {};

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`TRUNCATE agents, mlit_agents, property_owners, owners, users CASCADE`);
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (id, email, name, password_hash, updated_at, role, is_active) VALUES ($1::uuid, $2, 'x', 'x', now(), 'admin'::"Role", true)`,
      USER,
      "agent-name-db@example.com",
    );
    // 名簿(使っているもの・使っていないもの)
    await prisma.agent.create({ data: { companyName: "株式会社 ＡＢＣ不動産", phone: "03-0000-0000", createdById: USER } });
    await prisma.agent.create({ data: { companyName: "外した不動産株式会社", phone: "03-0000-0001", createdById: USER, isArchived: true } });
    // 国交省の一覧(会社と個人の業者)
    await prisma.mlitAgent.create({ data: { licenseKey: "13000001", authority: "13", licenseLabel: "東京都知事(1)第000001号", companyName: "(有)山田住宅" } });
    await prisma.mlitAgent.create({ data: { licenseKey: "13000002", authority: "13", licenseLabel: "東京都知事(1)第000002号", companyName: "髙橋 一郎" } });

    ids.abcCircle = await owner("㈱ABC不動産");
    ids.abcSpaced = await owner("株式会社　abc　不動産");
    ids.yamada = await owner("有限会社山田住宅");
    ids.takahashi = await owner("高橋一郎");
    ids.archived = await owner("外した不動産株式会社");
    ids.suffix = await owner("ABC不動産株式会社");
    ids.other = await owner("佐藤 花子");
    ids.blank = await owner("　");
    // 謄本の外字(私用領域の字)を含む名前(2026-11-11)
    ids.gaiji = await owner("大\uE0A6一郎");
    ids.gaijiEnd = await owner("鈴木花\uF8FF");
    // 異体字(𠮷=サロゲートペア・澤)を SQL の translate でそろえる(2026-11-11)
    await prisma.mlitAgent.create({ data: { licenseKey: "13000003", authority: "13", licenseLabel: "東京都知事(1)第000003号", companyName: "\u{20BB7}田不動産" } });
    await prisma.mlitAgent.create({ data: { licenseKey: "13000004", authority: "13", licenseLabel: "東京都知事(1)第000004号", companyName: "澤田 太郎" } });
    variantIds.yoshida = await owner("吉田不動産");
    variantIds.sawada = await owner("沢田太郎");
    variantIds.other = await owner("吉川不動産");
  });

  it("名簿・国交省の一覧の両方と、そろえた名前で照合する", async () => {
    const got = await findAgentNameOwnerIds(prisma, Object.values(ids));
    expect([...got].sort()).toEqual([ids.abcCircle, ids.abcSpaced, ids.yamada, ids.takahashi].sort());
  });

  it("広げた異体字(𠮷・澤)も SQL でそろえて照合する(2026-11-11)", async () => {
    const got = await findAgentNameOwnerIds(prisma, Object.values(variantIds));
    expect([...got].sort()).toEqual([variantIds.yoshida, variantIds.sawada].sort());
  });

  it("使っていない名簿の業者・後株と前株の違い・空の名前・別の名前は一致にしない", async () => {
    const got = await findAgentNameOwnerIds(prisma, [ids.archived, ids.suffix, ids.blank, ids.other]);
    expect(got.size).toBe(0);
  });

  it("名前に外字(私用領域の字)がある所有者を、業者とは別の集合で返す(2026-11-11)", async () => {
    const got = await findOwnerNameExclusions(prisma, Object.values(ids));
    expect([...got.gaijiOwnerIds].sort()).toEqual([ids.gaiji, ids.gaijiEnd].sort());
    expect(got.agentOwnerIds.has(ids.gaiji)).toBe(false);
    expect([...got.agentOwnerIds].sort()).toEqual([ids.abcCircle, ids.abcSpaced, ids.yamada, ids.takahashi].sort());
  });

  it("郵送に使う住所(現住所があれば現住所・無ければ登記上の住所)に外字があっても外す(2026-11-13 案A)", async () => {
    const mk = async (data: { address?: string | null; currentAddress?: string | null }) =>
      (await prisma.owner.create({ data: { name: "住所 太郎", ...data }, select: { id: true } })).id;
    const registryGaiji = await mk({ address: "東京都架空区町1" });
    const currentGaiji = await mk({ address: "東京都架空区見本町1", currentAddress: "神奈川県架空市町2" });
    const currentFull = await mk({ address: "東京都架空区町1", currentAddress: "神奈川県架空市見本町2" });
    const blankCurrent = await mk({ address: "東京都架空区町1", currentAddress: "　  ﻿ " });
    const plain = await mk({ address: "東京都架空区見本町1" });
    const got = await findOwnerNameExclusions(prisma, [registryGaiji, currentGaiji, currentFull, blankCurrent, plain]);
    // 現住所が入っている人は、登記上の住所に外字があっても刷らないので外さない。現住所が空白だけなら登記上の住所を刷る。
    expect([...got.gaijiOwnerIds].sort()).toEqual([registryGaiji, currentGaiji, blankCurrent].sort());
    expect(got.agentOwnerIds.size).toBe(0);
  });

  it("大文字の uuid でも同じ所有者として返す(返すのは小文字)", async () => {
    const got = await findAgentNameOwnerIds(prisma, [ids.yamada.toUpperCase()]);
    expect([...got]).toEqual([ids.yamada]);
  });
});
