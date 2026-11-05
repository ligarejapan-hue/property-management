/**
 * 謄本から読めた値で、物件(と棟)の**空の欄だけ**を埋める。
 * 2026-10-25 発注者「謄本を読み込んだ時も自動で面積を反映させたい」=面積。
 * 2026-11-01 発注者「謄本を入れているのに基本情報に反映されない」=地番・家屋番号・構造・築年月も。
 * 物件の画面で謄本を添付したとき・「この謄本から基本情報に反映」・謄本PDFの一括取込・謄本PDF取込で使う。
 * (物件を指定した謄本PDF取込・システムからの取得は processRegistryPdf の Mode A が番号と面積を埋め、ここで構造と築年月を埋める。)
 *
 * どの欄を埋めるかは planRegistryAreaFill(registry-area.ts)と planPropertyBasicFill / planBuildingFactsFill(registry-basic-info.ts)。
 * 書き方は Mode A と同じ: 物件行をロック → 現在値を読み直す → 編集中の鍵があれば見送る → 版番号つきで書く(version+1)→ 変更履歴(pdf_import)。
 * ⚠棟に紐づく部屋の構造・築年月は棟に書く(棟の値が正)。ロック順は 部屋の行 → 棟の行(システム全体の決まり)。
 * ⚠不動産番号には触らない(registry-basic-info.ts の先頭)。
 * ⚠書く見込みが無ければロックも取らない(所有者事項の謄本=書くものが無い、がほとんど)。
 */
import prisma from "@/lib/prisma";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { isResourceEditLocked } from "@/lib/edit-lock/service";
import { lockBuildingRowNoKeyUpdate } from "@/lib/edit-lock/row-locks";
import { recordChanges, PROPERTY_TRACKED_FIELDS, BUILDING_TRACKED_FIELDS } from "@/lib/change-log";
import { planRegistryAreaFill, registryAreasOf, type RegistryAreas } from "@/lib/registry-area";
import {
  parseRegistryBuildingFacts,
  planBuildingFactsFill,
  planPropertyBasicFill,
  registryIdentityOf,
  type RegistryBasicValues,
  type RegistryFillOutcome,
  type RegistryFillParcel,
} from "@/lib/registry-basic-info";
import { supportsUnitFields } from "@/lib/property-building-name";
import { extraParcelsText, fillExtraParcelArea, registryParcelTarget } from "@/lib/property-parcels";
import { extractHeadTextFromPdf } from "@/lib/pdf-extract";
import { parseRegistryText } from "@/lib/pdf-registry-parser";
import { safeErrorSummary } from "@/lib/safe-error-summary";

export type FillResult = Pick<RegistryFillOutcome, "filled" | "skippedByEditLock" | "parcel">;

/** 謄本から読めた値。読めないものは null・渡さないものは書かない。 */
export type RegistryFillValues = Partial<RegistryAreas> & Partial<RegistryBasicValues>;

const PROPERTY_SELECT = {
  version: true,
  propertyType: true,
  exclusiveAreaRegistry: true,
  landArea: true,
  landAreaMethod: true,
  totalFloorArea: true,
  buildingId: true,
  registryStatus: true,
  lotNumber: true,
  buildingNumber: true,
  structureType: true,
  builtYear: true,
  builtMonth: true,
  extraParcels: true,
  address: true,
} as const;

const BUILDING_SELECT = { version: true, structureType: true, builtYear: true, builtMonth: true } as const;

const NOTHING: FillResult = { filled: [], skippedByEditLock: false };
/** 読むページ数・時間の上限。 */
const HEAD_PAGES = 5;
const READ_TIMEOUT_MS = 15_000;
/** これより文字が少なければ画像の PDF とみなす(画像の PDF でもページの区切りの文字は出る)。 */
const MIN_READABLE_CHARS = 100;

const hasValue = (v: RegistryFillValues) => Object.values(v).some((x) => x !== null && x !== undefined);

function normalize(values: RegistryFillValues) {
  const areas: RegistryAreas = {
    unitFloorArea: values.unitFloorArea ?? null,
    landArea: values.landArea ?? null,
    buildingFloorArea: values.buildingFloorArea ?? null,
  };
  const basic: RegistryBasicValues = {
    lotNumber: values.lotNumber ?? null,
    buildingNumber: values.buildingNumber ?? null,
    structureType: values.structureType ?? null,
    builtYear: values.builtYear ?? null,
    builtMonth: values.builtMonth ?? null,
  };
  return { areas, basic };
}

export async function fillPropertyFromRegistry(args: {
  propertyId: string;
  values: RegistryFillValues;
  changedBy: string;
  /** 謄本の所在(同じ番号の土地・建物が2つ以上あるとき、どれのものかを決めるのに使う)。 */
  registryAddress?: string | null;
  /**
   * どの土地・建物の謄本かを決める番号(表の欄から読んだもの)。渡さなければ values の地番・家屋番号。
   * values に番号を入れると空の地番・家屋番号の欄を埋めるので、埋めたくない呼び出し元(Mode A・Mode B)はこちらで渡す。
   */
  parcelIdentity?: { lotNumber: string | null; buildingNumber: string | null };
}): Promise<FillResult> {
  const { propertyId, values, changedBy } = args;
  if (!hasValue(values)) return NOTHING;
  const { areas, basic } = normalize(values);
  const ident = args.parcelIdentity ?? { lotNumber: basic.lotNumber, buildingNumber: basic.buildingNumber };
  type Current = Parameters<typeof planPropertyBasicFill>[1] & Parameters<typeof planRegistryAreaFill>[1] & { extraParcels: unknown; address: string | null };
  /**
   * 2筆以上・2棟以上の物件(2026-11-05 案A 2回目): 謄本の地番・家屋番号で、どの土地・建物のものかを決める。
   * 足した行の謄本なら、その行の空いている面積だけ。1筆目とも足した行とも違う番号なら、足した行がある物件では何も書かない
   * (2筆目の面積・番号を1筆目の欄に入れない)。足した行が無い物件は今までどおり(案内だけ足す)。区分は今までどおり。
   */
  const planFor = (p: Current): { fill: Record<string, unknown>; buildingFacts: boolean; parcel: RegistryFillParcel | null } => {
    const main = () => ({ ...planRegistryAreaFill(areas, p), ...planPropertyBasicFill(basic, p) });
    const t = supportsUnitFields(p.propertyType) ? { target: "main" as const } : registryParcelTarget({ ...ident, address: args.registryAddress }, p);
    if (t.target === "main") return { fill: main(), buildingFacts: true, parcel: null };
    const parcel: RegistryFillParcel = {
      target: t.target, kind: t.kind, number: (t.kind === "building" ? ident.buildingNumber : ident.lotNumber) ?? "",
      ...(t.target === "unknown" && t.ambiguous ? { ambiguous: true } : {}),
    };
    if (t.target === "extra") {
      const raw = t.kind === "land" ? areas.landArea : areas.buildingFloorArea;
      const rows = fillExtraParcelArea(p.extraParcels, t.id, raw ? Number(raw) : null);
      return { fill: rows ? { extraParcels: rows } : {}, buildingFacts: false, parcel };
    }
    return t.hasExtras ? { fill: {}, buildingFacts: false, parcel } : { fill: main(), buildingFacts: true, parcel };
  };

  const before = await prisma.property.findUnique({ where: { id: propertyId }, select: PROPERTY_SELECT });
  if (!before) return NOTHING;
  const planBefore = planFor(before);
  const parcelOnly = planBefore.parcel ? { parcel: planBefore.parcel } : {};
  const buildingBefore = before.buildingId && planBefore.buildingFacts
    ? await prisma.building.findUnique({ where: { id: before.buildingId }, select: BUILDING_SELECT })
    : null;
  if (
    Object.keys(planBefore.fill).length === 0 &&
    (!buildingBefore || Object.keys(planBuildingFactsFill(basic, buildingBefore)).length === 0)
  ) {
    return { ...NOTHING, ...parcelOnly };
  }

  const result = await prisma.$transaction(async (tx) => {
    await lockPropertyRow(tx, propertyId);
    // ⚠ロックの後に読み直す(変更履歴の「変更前」と、空かどうかの判定に使う)。
    const fresh = await tx.property.findUnique({ where: { id: propertyId }, select: PROPERTY_SELECT });
    if (!fresh) return { fill: {}, fresh: null, buildingFill: {}, building: null, buildingId: null, skipped: false, parcel: null };
    const plan = planFor(fresh);
    const fill = plan.fill;
    if (fresh.buildingId && plan.buildingFacts) await lockBuildingRowNoKeyUpdate(tx, fresh.buildingId);
    const building = fresh.buildingId && plan.buildingFacts
      ? await tx.building.findUnique({ where: { id: fresh.buildingId }, select: BUILDING_SELECT })
      : null;
    const buildingFill = building ? planBuildingFactsFill(basic, building) : {};
    const base = { fresh, building, buildingId: fresh.buildingId, parcel: plan.parcel };
    if (Object.keys(fill).length === 0 && Object.keys(buildingFill).length === 0) {
      return { ...base, fill: {}, buildingFill: {}, skipped: false };
    }
    const locked = await isResourceEditLocked(tx, { resourceType: "property", resourceId: propertyId });
    if (locked) return { ...base, fill: {}, buildingFill: {}, skipped: true };
    let wroteProperty = false;
    if (Object.keys(fill).length > 0) {
      const written = await tx.property.updateMany({
        where: { id: propertyId, version: fresh.version },
        data: { ...fill, version: { increment: 1 } },
      });
      wroteProperty = written.count > 0;
    }
    let wroteBuilding = false;
    if (building && fresh.buildingId && Object.keys(buildingFill).length > 0) {
      const written = await tx.building.updateMany({
        where: { id: fresh.buildingId, version: building.version },
        data: { ...buildingFill, version: { increment: 1 } },
      });
      wroteBuilding = written.count > 0;
    }
    return { ...base, fill: wroteProperty ? fill : {}, buildingFill: wroteBuilding ? buildingFill : {}, skipped: false };
  });

  if (Object.keys(result.fill).length > 0 && result.fresh) {
    await recordChanges({
      targetTable: "properties",
      targetId: propertyId,
      changedBy,
      // ほかの土地・建物は一覧なので、読める文字(1行に1件)で残す(物件の編集の保存と同じ)。
      oldValues: { ...(result.fresh as unknown as Record<string, unknown>), extraParcels: extraParcelsText(result.fresh.extraParcels) },
      newValues: "extraParcels" in result.fill
        ? { ...(result.fill as Record<string, unknown>), extraParcels: extraParcelsText(result.fill.extraParcels) }
        : result.fill as Record<string, unknown>,
      // 構造・築年月は編集画面の保存では追跡していないが、自動で入れた跡は残す。
      trackedFields: [...PROPERTY_TRACKED_FIELDS, "structureType", "builtYear", "builtMonth", "extraParcels"],
      source: "pdf_import",
    });
  }
  if (Object.keys(result.buildingFill).length > 0 && result.building && result.buildingId) {
    await recordChanges({
      targetTable: "buildings",
      targetId: result.buildingId,
      changedBy,
      oldValues: result.building as unknown as Record<string, unknown>,
      newValues: result.buildingFill as Record<string, unknown>,
      trackedFields: BUILDING_TRACKED_FIELDS,
      source: "pdf_import",
    });
  }
  const filled = [...new Set([...Object.keys(result.fill), ...Object.keys(result.buildingFill)])];
  return { filled, skippedByEditLock: result.skipped, ...(result.parcel ? { parcel: result.parcel } : {}) };
}

/**
 * 謄本PDFの中身を読んで空の欄を埋める(添付・ボタン・一括取込の後に呼ぶ)。**失敗しても投げない**
 * (添付・取込そのものは成功させる)。ログには謄本の中身(住所・氏名)を出さない。
 * ⚠表題部は先頭にあるので先頭の数ページだけ読む・時間の上限つき(超えたら見送る)・読み終えたら後始末
 *   (extractHeadTextFromPdf)。添付の応答を長く止めない(内部レビュー P2)。
 */
export async function fillBasicInfoFromRegistryPdfBestEffort(args: {
  propertyId: string;
  pdf: Buffer;
  changedBy: string;
}): Promise<RegistryFillOutcome> {
  let text: string | null;
  try {
    text = await extractHeadTextFromPdf(args.pdf, { pages: HEAD_PAGES, timeoutMs: READ_TIMEOUT_MS });
  } catch (e) {
    console.error("registry basic info read failed:", safeErrorSummary(e));
    return { ...NOTHING, unreadable: true };
  }
  if (text == null || text.replace(/\s/g, "").length < MIN_READABLE_CHARS) {
    return { ...NOTHING, unreadable: true };
  }
  try {
    const parsed = parseRegistryText(text);
    const result = await fillPropertyFromRegistry({
      propertyId: args.propertyId,
      values: { ...registryAreasOf(parsed), ...registryIdentityOf(text), ...parseRegistryBuildingFacts(text) },
      registryAddress: parsed.address,
      changedBy: args.changedBy,
    });
    return { ...result, unreadable: false };
  } catch (e) {
    // ⚠読めているので「画像の謄本」とは案内しない(保存の失敗は押し直しで直る)。
    console.error("registry basic info fill failed:", safeErrorSummary(e));
    return { ...NOTHING, unreadable: false, failed: true };
  }
}
