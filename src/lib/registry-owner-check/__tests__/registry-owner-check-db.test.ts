/**
 * 謄本の名義の確認(本物の Postgres・2026-11-08)
 *
 * 確かめること: 比べ直しの印を立てるトリガー/比べた結果/「このままでよい」と DM を戻す/
 * 「謄本の名義に直す」(外す・足すが1つのトランザクション・失敗で何も変わらない・元に戻せる履歴)。
 * ⚠`PUSH_DB_TEST_URL`(全 migration を流した使い捨ての DB)があるときだけ動く。中身は消す。
 *   手元: 空の DB に `DATABASE_URL=<DB> npx prisma migrate deploy` →
 *   `PUSH_DB_TEST_URL=<DB> npx vitest run --no-file-parallelism <このファイル>`
 * ⚠謄本の中身は架空(並びだけ実物の所有者事項の表を写した)。PDF の読み取りは作り物
 *   (保存場所の「中身」=テキストを返す)にして、表の読み取り以降は本物を通す。
 */
import { describe, it, expect, vi } from "vitest";

vi.hoisted(() => {
  const url = process.env.PUSH_DB_TEST_URL;
  if (url) {
    process.env.DATABASE_URL = url;
    process.env.NEXT_PUBLIC_USE_MOCK = "true"; // 監査ログは書かない(writeAuditLog が飛ばす)
    process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || "db-test-secret";
  }
});

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

// 保存場所: fileUrl をそのままキーにして、登録したテキストを中身として返す
const TEXTS = new Map<string, string>();
vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...actual,
    getStorage: () => ({
      keyFromUrl: (u: string) => u,
      read: async (key: string) => (TEXTS.has(key) ? { body: Buffer.from(key) } : null),
    }),
  };
});
vi.mock("@/lib/pdf-extract", () => ({
  extractTextFromPdf: async (buf: Buffer) => TEXTS.get(buf.toString()) ?? "",
}));

import { randomUUID } from "crypto";
import prisma from "@/lib/prisma";
import {
  checkPropertyRegistryOwners,
  keepRegistryOwners,
  recordCheckAfterReplace,
  restoreDmSendIfHold,
  runRegistryOwnerChecks,
} from "@/lib/registry-owner-check/service";
import { replaceRegistryOwnersOnProperty } from "@/lib/registry-owner-apply/apply";

const failures: string[] = [];
function check(name: string, cond: boolean, extra?: unknown) {
  if (!cond) failures.push(`${name}${extra !== undefined ? " " + JSON.stringify(extra) : ""}`);
}

const ADDR = "東京都千代田区丸の内一丁目1番1号";
/** 所有者事項の表(2列)の並びを写した架空のテキスト */
function registryText(owners: Array<{ name: string; address?: string }>): string {
  const rows: string[] = [];
  owners.forEach((o, i) => {
    if (i > 0) rows.push("┠────────────────────┼─────────────┨");
    rows.push(`┃${o.address ?? ADDR} │${o.name} ┃`);
  });
  return [
    "2026/09/15 10:00 登記情報提供サービス。",
    "東京都千代田区丸の内一丁目1-1 所有者事項 （土地）",
    "┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓",
    "┃ 所 有 者 ┃",
    "┠────────────────────┬─────────────┨",
    "┃ 住 所 │ 氏 名 ┃",
    "┠────────────────────┼─────────────┨",
    ...rows,
    "┗━━━━━━━━━━━━━━━━━━┷━━━━━━━━━┛",
    "",
    "-- 1 of 1 --",
  ].join("\n");
}

const PERMS = [
  ...["owner_name", "owner_address"].map((resource) => ({ resource, action: "full", granted: true })),
];

async function reset() {
  TEXTS.clear();
  await prisma.$executeRawUnsafe(
    `TRUNCATE registry_owner_checks, change_logs, comments, property_owners, owners, attachments, import_job_rows, import_jobs, properties, users CASCADE`,
  );
}
async function user() {
  const id = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (id, email, name, password_hash, updated_at, role, is_active) VALUES ($1::uuid, $2, 'x', 'x', now(), 'admin'::"Role", true)`,
    id, `${id}@x.test`,
  );
  return id;
}
async function property(createdBy: string, dm = "hold") {
  const id = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO properties (id, property_type, address, registry_status, dm_status, created_by, updated_at) VALUES ($1::uuid, 'land', 'x', 'obtained', $3::"DmStatus", $2::uuid, now())`,
    id, createdBy, dm,
  );
  return id;
}
async function owner(name: string, address: string | null = ADDR) {
  const o = await prisma.owner.create({ data: { name, address }, select: { id: true } });
  return o.id;
}
async function link(propertyId: string, ownerId: string, extra: { note?: string; isPrimary?: boolean; relationship?: string } = {}) {
  await prisma.propertyOwner.create({ data: { propertyId, ownerId, ...extra } });
}
async function registry(propertyId: string, uploadedBy: string, owners: Array<{ name: string; address?: string }> | string) {
  const url = `/uploads/test/${randomUUID()}.pdf`;
  TEXTS.set(url, typeof owners === "string" ? owners : registryText(owners));
  const a = await prisma.attachment.create({
    data: {
      targetType: "property", targetId: propertyId, propertyId, type: "registry", registryCertificateType: "owner",
      fileName: "x.pdf", fileUrl: url, fileSize: 1, mimeType: "application/pdf", uploadedBy,
    },
    select: { id: true },
  });
  return a.id;
}
const row = (propertyId: string) => prisma.registryOwnerCheck.findUnique({ where: { propertyId } });
const linkedNames = async (propertyId: string) =>
  (await prisma.propertyOwner.findMany({ where: { propertyId }, select: { owner: { select: { name: true } } } }))
    .map((l) => l.owner.name).sort();
async function setFresh(propertyId: string) {
  await prisma.registryOwnerCheck.update({ where: { propertyId }, data: { stale: false } });
}

async function main() {
  // ---- 1. 比べた結果: 同じ/表記の違い/違う/読めない/所有者なし ----
  await reset();
  {
    const u = await user();
    const same = await property(u);
    await link(same, await owner("山田太郎"));
    await registry(same, u, [{ name: "山田　太郎" }]);
    const notation = await property(u);
    await link(notation, await owner("高橋一郎"));
    await registry(notation, u, [{ name: "髙橋一郎" }]);
    const diff = await property(u);
    await link(diff, await owner("佐藤一郎"));
    await registry(diff, u, [{ name: "鈴木一郎" }]);
    const unreadable = await property(u);
    await link(unreadable, await owner("佐藤一郎"));
    await registry(unreadable, u, "表のない文字だけ");
    const noOwner = await property(u);
    await registry(noOwner, u, [{ name: "山田太郎" }]);
    const noRegistry = await property(u);

    const r = await runRegistryOwnerChecks(50);
    check("1a 対象5件を比べて残り0", r.processed === 5 && r.remaining === 0 && r.failed === 0, r);
    check(
      "1b 結果ごとの件数",
      r.counts.same === 1 && r.counts.same_notation === 1 && r.counts.mismatch === 1 && r.counts.unreadable === 1 && r.counts.no_owner === 1,
      r.counts,
    );
    check("1c 異体字だけ=同じ(表記の違い)", (await row(notation))?.result === "same_notation");
    check("1d 謄本の無い物件は行を作らない", (await row(noRegistry)) === null);
    const again = await runRegistryOwnerChecks(50);
    check("1e 2回目は0件", again.processed === 0, again);
  }

  // ---- 2. トリガー: 所有者の付け外し・氏名の変更・謄本の追加と削除で比べ直しの印 ----
  await reset();
  {
    const u = await user();
    const p = await property(u);
    const o1 = await owner("佐藤一郎");
    await link(p, o1);
    await registry(p, u, [{ name: "鈴木一郎" }]);
    await checkPropertyRegistryOwners(p);
    check("2a 比べたあとは印なし", (await row(p))?.stale === false);
    const o2 = await owner("佐藤花子");
    await link(p, o2);
    check("2b 所有者を足すと印", (await row(p))?.stale === true);
    await setFresh(p);
    await prisma.propertyOwner.deleteMany({ where: { propertyId: p, ownerId: o2 } });
    check("2c 所有者を外すと印", (await row(p))?.stale === true);
    await setFresh(p);
    await prisma.owner.update({ where: { id: o1 }, data: { name: "鈴木一郎" } });
    check("2d 氏名を変えると印", (await row(p))?.stale === true);
    await setFresh(p);
    await prisma.owner.update({ where: { id: o1 }, data: { updatedAt: new Date() } });
    check("2e 氏名以外の更新では印なし", (await row(p))?.stale === false);
    const a2 = await registry(p, u, [{ name: "鈴木一郎" }]);
    check("2f 謄本を足すと印", (await row(p))?.stale === true);
    await setFresh(p);
    await prisma.attachment.update({ where: { id: a2 }, data: { isDeleted: true, deletedAt: new Date() } });
    check("2g 謄本を消すと印", (await row(p))?.stale === true);
    const r = await runRegistryOwnerChecks(50);
    check("2h 印のある物件は比べ直す(氏名を直したので同じ)", r.processed === 1 && (await row(p))?.result === "same", r);
  }

  // ---- 3. このままでよい+DM を戻す・同じ謄本なら判断は残る・新しい謄本で消える ----
  await reset();
  {
    const u = await user();
    const p = await property(u, "hold");
    await link(p, await owner("佐藤一郎"));
    const a1 = await registry(p, u, [{ name: "鈴木一郎" }]);
    await checkPropertyRegistryOwners(p);
    const out = await keepRegistryOwners({ session: { id: u, role: "admin" }, propertyId: p, expectedAttachmentId: a1, restoreDm: true });
    const prop = await prisma.property.findUniqueOrThrow({ where: { id: p }, select: { dmStatus: true, version: true } });
    const logs = await prisma.changeLog.findMany({ where: { targetId: p, fieldName: "dmStatus" } });
    check("3a 判断が残り DM は送付可・版+1・履歴 hold→send", out.dmRestored && (await row(p))?.decision === "keep" && prop.dmStatus === "send" && prop.version === 2 && logs.length === 1 && logs[0].oldValue === "hold" && logs[0].newValue === "send", { out, prop, logs });
    let second409 = false;
    try {
      await keepRegistryOwners({ session: { id: u, role: "admin" }, propertyId: p, expectedAttachmentId: a1, restoreDm: true });
    } catch (e) {
      second409 = (e as { status?: number }).status === 409;
    }
    check("3b 2回目は 409", second409);
    // 同じ謄本のまま比べ直しても判断は残る
    await prisma.registryOwnerCheck.update({ where: { propertyId: p }, data: { stale: true } });
    await checkPropertyRegistryOwners(p);
    check("3c 同じ謄本なら判断は残る", (await row(p))?.decision === "keep");
    await registry(p, u, [{ name: "鈴木一郎" }]);
    await checkPropertyRegistryOwners(p);
    check("3d 新しい謄本が付いたら判断は消える", (await row(p))?.decision === null && (await row(p))?.result === "mismatch");
    const p2 = await property(u, "no_send");
    const restored = await prisma.$transaction((tx) => restoreDmSendIfHold(tx, p2, u));
    check("3e DM が未判断でなければ触らない", !restored && (await prisma.property.findUniqueOrThrow({ where: { id: p2 } })).dmStatus === "no_send");
  }

  // ---- 4. 謄本の名義に直す: 外す・足す・履歴・結果・DM は保留のまま ----
  await reset();
  {
    const u = await user();
    const p = await property(u, "hold");
    const keepId = await owner("山田太郎");
    const removeId = await owner("佐藤一郎");
    await link(p, keepId, { isPrimary: true });
    await link(p, removeId, { relationship: "共有者" });
    const a = await registry(p, u, [{ name: "山田太郎" }, { name: "山田花子" }]);
    await checkPropertyRegistryOwners(p);
    const out = await replaceRegistryOwnersOnProperty({
      session: { id: u, role: "admin" },
      perms: PERMS,
      propertyId: p,
      expectedAttachmentId: a,
      expectedLinkedOwnerIds: [keepId, removeId],
      expectedRemoveOwnerIds: [removeId],
      beforeCommit: async (tx, names) => {
        await recordCheckAfterReplace(tx, p, a, names);
      },
    });
    const names = await linkedNames(p);
    const logs = await prisma.changeLog.findMany({ where: { targetTable: "property_owners", propertyId: p } });
    const unlink = logs.find((l) => l.fieldName === "_unlinked_from_property");
    check("4a 外した1名・足した1名", out.removed === 1 && out.added === 1, out);
    check("4b 物件の所有者は謄本どおり", JSON.stringify(names) === JSON.stringify(["山田太郎", "山田花子"].sort()), names);
    check(
      "4c 外した人は履歴から戻せる(所有者ID・主所有者か・関係)",
      unlink?.oldValue === removeId &&
        logs.some((l) => l.fieldName === "isPrimary" && l.oldValue === "false") &&
        logs.some((l) => l.fieldName === "relationship" && l.oldValue === "共有者"),
      logs,
    );
    check("4d 外した人の記録そのものは残る", (await prisma.owner.count({ where: { id: removeId } })) === 1);
    const r = await row(p);
    check("4e 比べ直した結果は同じ・印なし", r?.result === "same" && r?.stale === false, r);
    check("4f DM は保留のまま", (await prisma.property.findUniqueOrThrow({ where: { id: p } })).dmStatus === "hold");
  }

  // ---- 5. 途中で失敗したら何も変わらない ----
  await reset();
  {
    const u = await user();
    const p = await property(u);
    const removeId = await owner("佐藤一郎");
    await link(p, removeId);
    const a = await registry(p, u, [{ name: "鈴木一郎" }]);
    let threw = false;
    try {
      await replaceRegistryOwnersOnProperty({
        session: { id: u, role: "admin" },
        perms: PERMS,
        propertyId: p,
        expectedAttachmentId: a,
        expectedLinkedOwnerIds: [removeId],
        expectedRemoveOwnerIds: [removeId],
        beforeCommit: async () => {
          throw new Error("boom");
        },
      });
    } catch {
      threw = true;
    }
    const names = await linkedNames(p);
    check("5a 失敗したら外した人も足した人も元どおり", threw && JSON.stringify(names) === JSON.stringify(["佐藤一郎"]), names);
    check("5b 失敗したら新しい所有者も作られない", (await prisma.owner.count({ where: { name: "鈴木一郎" } })) === 0);
    check("5c 失敗したら履歴も残らない", (await prisma.changeLog.count({ where: { propertyId: p } })) === 0);
  }

  // ---- 6. 確認画面のあとに所有者が変わったら 409・メモのある人は外さない・余分な人だけを外す ----
  await reset();
  {
    const u = await user();
    const p = await property(u);
    const o1 = await owner("山田太郎");
    const extra = await owner("山田花子");
    await link(p, o1);
    await link(p, extra);
    const a = await registry(p, u, [{ name: "山田太郎" }]);
    const added = await owner("田中一郎");
    await link(p, added); // 確認画面のあとに足された
    let status = 0;
    try {
      await replaceRegistryOwnersOnProperty({
        session: { id: u, role: "admin" }, perms: PERMS, propertyId: p, expectedAttachmentId: a,
        expectedLinkedOwnerIds: [o1, extra], expectedRemoveOwnerIds: [extra],
      });
    } catch (e) {
      status = (e as { status?: number }).status ?? -1;
    }
    check("6a 所有者が変わっていたら 409", status === 409, status);
    await prisma.propertyOwner.deleteMany({ where: { propertyId: p, ownerId: added } });

    await prisma.propertyOwner.updateMany({ where: { propertyId: p, ownerId: extra }, data: { note: "鍵は管理会社" } });
    status = 0;
    try {
      await replaceRegistryOwnersOnProperty({
        session: { id: u, role: "admin" }, perms: PERMS, propertyId: p, expectedAttachmentId: a,
        expectedLinkedOwnerIds: [o1, extra], expectedRemoveOwnerIds: [extra],
      });
    } catch (e) {
      status = (e as { status?: number }).status ?? -1;
    }
    check("6b メモのある人は外さない(409・何も変えない)", status === 409 && (await linkedNames(p)).length === 2, status);

    await prisma.propertyOwner.updateMany({ where: { propertyId: p, ownerId: extra }, data: { note: null } });
    const out = await replaceRegistryOwnersOnProperty({
      session: { id: u, role: "admin" }, perms: PERMS, propertyId: p, expectedAttachmentId: a,
      expectedLinkedOwnerIds: [o1, extra], expectedRemoveOwnerIds: [extra],
    });
    check("6c 足す人がいなくても外す", out.removed === 1 && out.added === 0 && JSON.stringify(await linkedNames(p)) === JSON.stringify(["山田太郎"]), out);
  }

  // ---- 7. すでに比べ直し待ちの行でも、比べている最中の氏名の変更は待たされ、印が残る(@codex #678 R1) ----
  await reset();
  {
    const u = await user();
    const p = await property(u);
    const o = await owner("佐藤一郎");
    await link(p, o);
    await registry(p, u, [{ name: "鈴木一郎" }]);
    await checkPropertyRegistryOwners(p);
    await prisma.registryOwnerCheck.update({ where: { propertyId: p }, data: { stale: true } });
    let renamed = false;
    let renamePromise: Promise<unknown> | null = null;
    await prisma.$transaction(async (tx) => {
      // 比べる処理と同じく、結果の行を押さえてから(古い)氏名を読んだ状態
      await tx.$queryRaw`SELECT 1 FROM registry_owner_checks WHERE property_id = ${p}::uuid FOR UPDATE`;
      renamePromise = prisma.owner.update({ where: { id: o }, data: { name: "鈴木一郎" } }).then(() => {
        renamed = true;
      });
      await new Promise((r) => setTimeout(r, 500));
      check("7a 氏名の変更は比べている処理の確定を待つ", renamed === false);
      await tx.registryOwnerCheck.update({ where: { propertyId: p }, data: { stale: false, result: "mismatch" } });
    });
    await renamePromise;
    check("7b 変更のあとは比べ直し待ちに戻る", renamed && (await row(p))?.stale === true);
  }
}

describe.skipIf(!process.env.PUSH_DB_TEST_URL)("謄本の名義の確認(本物の Postgres)", () => {
  it("すべての確認項目が通る", async () => {
    try {
      await main();
    } finally {
      await prisma.$disconnect();
    }
    expect(failures).toEqual([]);
  }, 600_000);
});
