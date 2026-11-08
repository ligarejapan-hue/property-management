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
      read: async (key: string) => {
        // 思わぬ失敗(保存場所の故障など)の作り物
        if (key.includes("/broken/")) throw new Error("storage down");
        return TEXTS.has(key) ? { body: Buffer.from(key) } : null;
      },
    }),
  };
});
// 中身が HANG の謄本は「上限を渡されたら時間切れ」の作り物(本物の打ち切りは pdf-extract-timeout.test)
const HANG = "__HANG__";
const READ_TIMEOUTS: Array<number | undefined> = [];
vi.mock("@/lib/pdf-extract", () => ({
  extractTextFromPdf: async (buf: Buffer, opts: { timeoutMs?: number } = {}) => {
    READ_TIMEOUTS.push(opts.timeoutMs);
    const text = TEXTS.get(buf.toString()) ?? "";
    if (text === HANG && opts.timeoutMs !== undefined) {
      throw Object.assign(new Error("PDF read timed out"), { code: "PDF_READ_TIMEOUT" });
    }
    return text;
  },
}));

import { randomUUID } from "crypto";
import prisma from "@/lib/prisma";
import {
  checkPropertyRegistryOwners,
  keepRegistryOwners,
  recordCheckAfterReplace,
  restoreDmSendIfHold,
  runNightlyRegistryOwnerChecks,
  runRegistryOwnerChecks,
  NIGHTLY_REGISTRY_OWNER_CHECK,
  REGISTRY_OWNER_READ_TIMEOUT_MS,
} from "@/lib/registry-owner-check/service";
import { QUALITY_RULES, qualityWarningWhere } from "@/lib/quality-check-rules";
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

  // ---- 8. 思わぬ失敗(一時的な故障)は比べ直し待ちのまま残し、前の結果も消さない(@codex #679 R1) ----
  await reset();
  {
    const u = await user();
    const bad = await property(u);
    await link(bad, await owner("佐藤一郎"));
    // 前に一度「違う」と比べてある物件の謄本の保存場所が、一時的に壊れた
    const brokenUrl = `/uploads/broken/${randomUUID()}.pdf`;
    const okUrl = brokenUrl.replace("/broken/", "/ok/");
    TEXTS.set(okUrl, registryText([{ name: "鈴木一郎" }]));
    await prisma.attachment.create({
      data: {
        targetType: "property", targetId: bad, propertyId: bad, type: "registry", registryCertificateType: "owner",
        fileName: "x.pdf", fileUrl: okUrl, fileSize: 1, mimeType: "application/pdf", uploadedBy: u,
      },
    });
    await checkPropertyRegistryOwners(bad);
    await prisma.$executeRawUnsafe(`UPDATE attachments SET file_url = $1 WHERE property_id = $2::uuid`, brokenUrl, bad);
    // (保存先の文字列はトリガーの対象外=比べ直し待ちは手で立てる)
    await prisma.registryOwnerCheck.update({ where: { propertyId: bad }, data: { stale: true } });
    const r1 = await runRegistryOwnerChecks(50);
    const after1 = await row(bad);
    check("8a 失敗は数え、比べ直し待ちのまま・前の結果(違う)は残す", r1.failed === 1 && after1?.stale === true && after1?.result === "mismatch", { r1, after1 });
    // 夜の自動は1時間後回し、画面のボタンは今すぐ試す
    const jstNow = new Date(Date.now() + 9 * 3600_000);
    let night3 = Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate(), 3) - 9 * 3600_000;
    if (night3 > Date.now()) night3 -= 24 * 3600_000;
    const nightly = await runNightlyRegistryOwnerChecks(new Date(night3));
    check("8b 夜の自動は失敗したばかりの物件を後回しにする", "processed" in nightly && nightly.processed === 0, nightly);
    const r2 = await runRegistryOwnerChecks(50);
    check("8c 画面のボタンはもう一度試す", r2.processed === 1 && r2.failed === 1, r2);
    // 故障が直れば、次に比べたとき結果が確定する
    await prisma.$executeRawUnsafe(`UPDATE attachments SET file_url = $1 WHERE property_id = $2::uuid`, okUrl, bad);
    await prisma.registryOwnerCheck.update({ where: { propertyId: bad }, data: { stale: true } });
    const r3 = await runRegistryOwnerChecks(50);
    check("8d 直れば比べられる", r3.processed === 1 && r3.failed === 0 && (await row(bad))?.stale === false, r3);
  }

  // ---- 9. 夜の自動の比べ: 日本時間 2〜5時だけ・1回の上限・1晩の上限 ----
  await reset();
  {
    const u = await user();
    const ids: string[] = [];
    for (let i = 0; i < NIGHTLY_REGISTRY_OWNER_CHECK.perTick + 5; i++) {
      const p = await property(u);
      await link(p, await owner("佐藤一郎"));
      await registry(p, u, [{ name: "佐藤一郎" }]);
      ids.push(p);
    }
    // 日本時間 1:59(=UTC 16:59)は動かない、3:00(=UTC 18:00)は動く
    const before = await runNightlyRegistryOwnerChecks(new Date(Date.UTC(2026, 10, 8, 16, 59)));
    check("9a 枠の外は動かない", "skipped" in before && before.skipped === "outside_window", before);
    const afterWindow = await runNightlyRegistryOwnerChecks(new Date(Date.UTC(2026, 10, 8, 20, 0)));
    check("9b 5時を過ぎたら動かない", "skipped" in afterWindow && afterWindow.skipped === "outside_window", afterWindow);
    // 夜の枠の中の時刻=「今」より前の夜(日本時間)の 3:00。比べた件数は checked_at>=その夜の2:00 で数える
    // (今比べた行は必ずその夜の2:00より後=数えに入る)。
    const jstNow = new Date(Date.now() + 9 * 3600_000);
    let night3 = Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate(), 3) - 9 * 3600_000;
    if (night3 > Date.now()) night3 -= 24 * 3600_000;
    const t1 = await runNightlyRegistryOwnerChecks(new Date(night3));
    check("9c 1回は perTick 件まで", "processed" in t1 && t1.processed === NIGHTLY_REGISTRY_OWNER_CHECK.perTick && t1.counts.same === NIGHTLY_REGISTRY_OWNER_CHECK.perTick, t1);
    const t2 = await runNightlyRegistryOwnerChecks(new Date(night3), { perNight: NIGHTLY_REGISTRY_OWNER_CHECK.perTick + 2 });
    check("9d 1晩の上限までの残りだけ比べる", "processed" in t2 && t2.processed === 2 && t2.doneTonight === NIGHTLY_REGISTRY_OWNER_CHECK.perTick + 2, t2);
    const t3 = await runNightlyRegistryOwnerChecks(new Date(night3), { perNight: NIGHTLY_REGISTRY_OWNER_CHECK.perTick + 2 });
    check("9e 上限に達したらその夜はもう動かない", "skipped" in t3 && t3.skipped === "nightly_cap", t3);
    const t4 = await runNightlyRegistryOwnerChecks(new Date(night3), { deadline: Date.now() - 1 });
    check("9f 持ち時間が無ければ始めない", "skipped" in t4 && t4.skipped === "no_time", t4);
    void ids;
  }

  // ---- 10. 品質チェックの警告: 取得済+違う+未判断+比べ直し待ちでない だけ・DM で重さが分かれる ----
  await reset();
  {
    const u = await user();
    const send = await property(u, "send");
    const hold = await property(u, "hold");
    const kept = await property(u, "send");
    const staleP = await property(u, "send");
    for (const p of [send, hold, kept, staleP]) {
      await link(p, await owner("佐藤一郎"));
      await registry(p, u, [{ name: "鈴木一郎" }]);
      await checkPropertyRegistryOwners(p);
    }
    await prisma.registryOwnerCheck.update({ where: { propertyId: kept }, data: { decision: "keep" } });
    await prisma.registryOwnerCheck.update({ where: { propertyId: staleP }, data: { stale: true } });
    const ruleIds = async (code: string) => {
      const rule = QUALITY_RULES.find((r) => r.code === code)!;
      return (await prisma.property.findMany({ where: { isArchived: false, ...rule.where }, select: { id: true } })).map((p) => p.id);
    };
    const err = await ruleIds("REGISTRY_OWNER_MISMATCH_DM_SEND");
    const warn = await ruleIds("REGISTRY_OWNER_MISMATCH");
    check("10a DM 送付可はエラーの決まりだけ", JSON.stringify(err) === JSON.stringify([send]), err);
    check("10b 保留は警告の決まりだけ", JSON.stringify(warn) === JSON.stringify([hold]), warn);
    const warnAll = (await prisma.property.findMany({ where: { isArchived: false, ...qualityWarningWhere() }, select: { id: true } })).map((p) => p.id);
    check("10c 警告ありのみにも入る(同じ定義)", warnAll.includes(send) && warnAll.includes(hold), warnAll);
    await prisma.property.update({ where: { id: hold }, data: { registryStatus: "unconfirmed" } });
    check("10d 登記が取得済でなければ出さない", (await ruleIds("REGISTRY_OWNER_MISMATCH")).length === 0);
  }

  // ---- 11. 謄本1件の読み込みの時間切れ(20秒): 読めないで確定させず、比べ直し待ちのまま・前の結果は残す ----
  await reset();
  {
    const u = await user();
    const slow = await property(u);
    await link(slow, await owner("佐藤一郎"));
    const attachmentId = await registry(slow, u, [{ name: "鈴木一郎" }]);
    READ_TIMEOUTS.length = 0;
    await checkPropertyRegistryOwners(slow);
    check("11a 比べるときは20秒の上限を渡す", READ_TIMEOUTS.length === 1 && READ_TIMEOUTS[0] === REGISTRY_OWNER_READ_TIMEOUT_MS && REGISTRY_OWNER_READ_TIMEOUT_MS === 20_000, READ_TIMEOUTS);
    // 同じ謄本の中身が、次に読むときは時間内に読み終わらない
    const url = (await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId }, select: { fileUrl: true } })).fileUrl;
    TEXTS.set(url, HANG);
    await prisma.registryOwnerCheck.update({ where: { propertyId: slow }, data: { stale: true } });
    const r = await runRegistryOwnerChecks(50);
    const after = await row(slow);
    check("11b 時間切れは失敗と数え、読めないにしない・前の結果(違う)は残す", r.failed === 1 && after?.stale === true && after?.result === "mismatch", { r, after });
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
