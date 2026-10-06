/**
 * 物件と棟をつなぐ処理の DB 側(設計 2026-10-04 §4.3)。全部の保存の入口がここを通る。
 *
 * ⚠**必ず物件を保存するのと同じトランザクションの tx を渡す**。
 * ⚠ロック順(システム全体): **部屋(物件)の行 → 棟の行**。物件の保存は「物件の行 → (ここ)アドバイザリロック」、
 *   棟の名前の反映・販売図面の書き戻しも 部屋 → 棟。ここは**棟の行を待たない**(読むだけ・
 *   key の補完は SKIP LOCKED・外部キーは FOR KEY SHARE)ので、棟の行を持つ側と待ち合わない。
 * ⚠ここでの物件の行の書き込み(buildingId・buildingName)は**版番号を進めない**。呼び出し側が
 *   同じトランザクションで「物件を作る(新しい行)」か「version を進める更新」をした後に呼ぶこと
 *   (版番号を2回進めない。version-increment-scan.test.ts の ALLOWED_WITHOUT_VERSION)。
 */
import type { Prisma } from "@/generated/prisma";
import { ApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { areaKey, buildingAddressFromUnit, buildingNameKey } from "@/lib/building-identity";
import {
  BUILDING_LINK_TARGET_TYPE,
  buildingLinkLockKey,
  decideBuildingLink,
  type BuildingChoice,
  type BuildingLinkWarning,
  type LinkCandidate,
} from "./resolve";
import { LEGACY_PAGE_SIZE, readAllLegacyBuildings } from "./suggest";

export type BuildingLinkTx = Pick<Prisma.TransactionClient, "$executeRaw"> & {
  building: Pick<Prisma.TransactionClient["building"], "findUnique" | "findMany" | "create">;
  property: Pick<Prisma.TransactionClient["property"], "update">;
  auditLog: Pick<Prisma.TransactionClient["auditLog"], "create">;
};

export interface ApplyBuildingLinkInput {
  propertyId: string;
  propertyType: string;
  buildingName: string | null; // いま物件に保存されている(=保存した)物件名
  address: string;
  buildingNumber: string | null;
  choice: BuildingChoice;
  currentBuildingId: string | null;
  userId: string;
  /** 取込の経路(CSV・要確認の確定・再試行)だけ渡す。棟を作ったら同じ tx で目印を書く(下)。 */
  importJobId?: string | null;
}

export interface BuildingLinkOutcome {
  action: "none" | "kept" | "linked" | "created" | "unlinked";
  building: { id: string; name: string } | null; // kept/linked/created のとき
  previousBuildingId: string | null;
  renamedFrom: string | null; // 物件名を棟の表記にそろえたときの入力
  warnings: BuildingLinkWarning[];
}

/** 棟の比べる形と町丁目(棟を作る・名前や住所を変えるときに列へ入れる値)。 */
export function buildingIdentityKeys(
  name: string,
  address: string,
): { nameKey: string | null; areaKey: string | null } {
  return { nameKey: buildingNameKey(name), areaKey: areaKey(address) };
}

/**
 * 同じ町丁目・同じ比べる形の棟だけを候補にする(D2)。⚠decideBuildingLink は候補を絞らないので、
 * 絞り込みはここが責任を持つ。必ずアドバイザリロックの**あと**に呼ぶ(読み直し)。
 */
async function loadCandidates(tx: BuildingLinkTx, area: string, nameKey: string): Promise<LinkCandidate[]> {
  const select = { id: true, name: true, address: true, createdAt: true, _count: { select: { properties: true } } } as const;
  const keyed = await tx.building.findMany({ where: { areaKey: area, nameKey }, select });
  // ⚠[@codex R7] key が null の古い棟は**上限なしで全部**読む(id 順に200件ずつ)。件数で切ると、
  //   枠の外の同じ棟を見落として重複の棟を作る(候補の画面は「保存時に自動で判断」と案内している)。
  //   ページ送りは id の続き(gt)で読む(読んでいる間に他の保存が key を埋めても行がずれない)。
  //   読んだ行は下ですべて key を埋めるので、古い棟は最初の数回の保存で無くなる。
  const { rows: unkeyed } = await readAllLegacyBuildings(
    ({ cursorId, take }) =>
      tx.building.findMany({
        where: { nameKey: null, ...(cursorId ? { id: { gt: cursorId } } : {}) },
        select,
        orderBy: { id: "asc" },
        take,
      }),
    LEGACY_PAGE_SIZE,
    Number.POSITIVE_INFINITY,
  );
  const matched: typeof unkeyed = [];
  for (const b of unkeyed) {
    const keys = buildingIdentityKeys(b.name, b.address);
    // ⚠**SKIP LOCKED**: 棟の名前の反映が棟の行を持っている間は待たずに飛ばす(待ちの輪を作らない)。
    //   埋められなかった行は次の機会に埋まる。比べる判断はこの場で計算した key で行う。
    await tx.$executeRaw`UPDATE "buildings" SET "name_key" = ${keys.nameKey}, "area_key" = ${keys.areaKey} WHERE "id" = (SELECT "id" FROM "buildings" WHERE "id" = ${b.id}::uuid AND "name_key" IS NULL FOR UPDATE SKIP LOCKED)`;
    if (keys.nameKey === nameKey && keys.areaKey === area) matched.push(b);
  }
  return [...keyed, ...matched].map((b) => ({
    id: b.id,
    name: b.name,
    unitCount: b._count.properties,
    createdAt: b.createdAt,
  }));
}

export async function applyBuildingLink(
  tx: BuildingLinkTx,
  input: ApplyBuildingLinkInput,
): Promise<BuildingLinkOutcome> {
  const nameKey = buildingNameKey(input.buildingName);
  const area = areaKey(input.address);
  const none: BuildingLinkOutcome = {
    action: "none", building: null, previousBuildingId: input.currentBuildingId, renamedFrom: null, warnings: [],
  };
  const common = {
    propertyType: input.propertyType,
    buildingName: input.buildingName,
    nameKey,
    areaKey: area,
    choice: input.choice,
  };

  // DB を見ずに決まるもの(対象外の種別・物件名が空)
  if (input.propertyType !== BUILDING_LINK_TARGET_TYPE || nameKey === null) {
    const d = decideBuildingLink({ ...common, current: null, chosen: null, candidates: [] });
    if (d.kind === "unlink" && input.currentBuildingId) {
      await tx.property.update({ where: { id: input.propertyId }, data: { buildingId: null } });
      return { ...none, action: "unlinked" };
    }
    return none;
  }

  // 今の棟は比べる形を持たせて渡す(列が null の古い行はその場で計算)。⚠棟の行はロックしない。
  const currentRow = input.currentBuildingId
    ? await tx.building.findUnique({ where: { id: input.currentBuildingId }, select: { id: true, name: true, nameKey: true } })
    : null;
  const current = currentRow
    ? { id: currentRow.id, name: currentRow.name, nameKey: currentRow.nameKey ?? buildingNameKey(currentRow.name) }
    : null;

  let chosen: { id: string; name: string } | null = null;
  let candidates: LinkCandidate[] = [];
  if (input.choice.kind === "existing") {
    chosen = await tx.building.findUnique({ where: { id: input.choice.buildingId }, select: { id: true, name: true } });
  } else {
    // 順番待ち → **ロックのあとに**読み直す(同時に来た2人目は1人目が作った棟を見つける)。
    // ⚠$executeRaw + ::bigint(paste commit の前例と同じ。$queryRaw は void 列で落ちる)。
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${buildingLinkLockKey(area, nameKey)})::bigint)`;
    if (area !== null) candidates = await loadCandidates(tx, area, nameKey);
  }

  const d = decideBuildingLink({ ...common, current, chosen, candidates });
  if (d.kind === "chosen_missing") {
    throw new ApiError(409, "選んだ棟が見つかりません。棟を選び直してください", "BUILDING_NOT_FOUND");
  }
  if (d.kind === "keep" || d.kind === "unlink") return none; // 上で処理済み(型を閉じるため)

  let building: { id: string; name: string };
  let created = false;
  if (d.kind === "create") {
    building = await tx.building.create({
      data: {
        name: input.buildingName as string,
        address: buildingAddressFromUnit(input.address, input.buildingNumber),
        nameKey,
        areaKey: area,
        createdBy: input.userId,
      },
      select: { id: true, name: true },
    });
    created = true;
    // 取込が作った棟の目印(取り消しが空の棟を消すときに引く=building-link/rollback.ts)。
    // ⚠**棟を作ったのと同じ tx で書く**(@codex P2・2026-10-05): writeAuditLog は失敗を握りつぶすので、
    //   tx の後に書くと、書けなかった棟は取り消しで見つからず空のまま残る。ここなら書けなければ
    //   棟も物件も一緒に巻き戻る。migration を足さずに、既存の監査ログの表を同じ形で使う。id だけ・住所なし。
    if (input.importJobId) {
      await tx.auditLog.create({
        data: {
          userId: input.userId,
          action: "building.auto_create",
          targetTable: "buildings",
          targetId: building.id,
          detail: { propertyId: input.propertyId, importJobId: input.importJobId },
        },
      });
    }
  } else {
    building = { id: d.buildingId, name: d.buildingName };
  }

  const renamedFrom = input.buildingName !== building.name ? input.buildingName : null;
  if (input.currentBuildingId !== building.id || renamedFrom !== null) {
    await tx.property.update({
      where: { id: input.propertyId },
      data: { buildingId: building.id, buildingName: building.name },
    });
  }
  return {
    action: created ? "created" : input.currentBuildingId === building.id ? "kept" : "linked",
    building,
    previousBuildingId: input.currentBuildingId,
    renamedFrom,
    warnings: d.warnings,
  };
}

/** 保存後の物件の棟と物件名(変更履歴・応答に使う)。buildingId=undefined は「変えていない」。 */
export function finalBuildingFields(
  outcome: BuildingLinkOutcome,
  savedName: string | null,
): { buildingId: string | null | undefined; buildingName: string | null } {
  if (outcome.action === "none") return { buildingId: undefined, buildingName: savedName };
  if (outcome.action === "unlinked") return { buildingId: null, buildingName: savedName };
  return { buildingId: outcome.building?.id ?? null, buildingName: outcome.building?.name ?? savedName };
}

/**
 * 監査ログ(トランザクションの外で呼ぶ)。⚠detail に住所を入れない。
 * 取込の経路(CSV・要確認の確定・再試行)は context.importJobId を渡す。そのときの棟の作成の記録は
 * applyBuildingLink が tx の中で書き済み(取り消しの目印)なので、ここでは二重に書かない。
 */
export async function writeBuildingLinkAudit(
  userId: string,
  propertyId: string,
  outcome: BuildingLinkOutcome,
  context: { importJobId?: string } = {},
): Promise<void> {
  if (outcome.action === "none" || outcome.action === "kept") return;
  if (outcome.action === "unlinked") {
    await writeAuditLog({
      userId, action: "property.building_unlink", targetTable: "properties", targetId: propertyId,
      detail: { previousBuildingId: outcome.previousBuildingId },
    });
    return;
  }
  const buildingId = outcome.building?.id ?? null;
  if (outcome.action === "created" && buildingId && !context.importJobId) {
    await writeAuditLog({
      userId, action: "building.auto_create", targetTable: "buildings", targetId: buildingId,
      detail: { propertyId },
    });
  }
  await writeAuditLog({
    userId,
    action: outcome.previousBuildingId ? "property.building_relink" : "property.building_link",
    targetTable: "properties",
    targetId: propertyId,
    detail: {
      buildingId,
      previousBuildingId: outcome.previousBuildingId,
      renamed: outcome.renamedFrom !== null,
      warnings: outcome.warnings,
    },
  });
}
