/**
 * 謄本から読めた面積で、物件の**空の欄だけ**を埋める(2026-10-25 発注者「謄本を読み込んだ時も自動で面積を反映させたい」)。
 * 物件の画面で謄本を添付したとき・謄本PDFの一括取込・謄本PDF取込(物件を指定しない)で使う。
 * (物件を指定した謄本PDF取込・システムからの取得は processRegistryPdf の Mode A が同じ決まりで埋める。)
 *
 * どの欄を埋めるかは planRegistryAreaFill(registry-area.ts)。書き方は Mode A と同じ:
 *   物件行をロック → 現在値を読み直す → 編集中の鍵があれば見送る → 版番号つきで書く(version+1)→ 変更履歴(pdf_import)。
 * ⚠面積だけを書く(不動産番号・地番などには触らない)。
 * ⚠書く見込みが無ければロックも取らない(所有者事項の謄本=面積が無い、がほとんど)。
 */
import prisma from "@/lib/prisma";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { isResourceEditLocked } from "@/lib/edit-lock/service";
import { recordChanges, PROPERTY_TRACKED_FIELDS } from "@/lib/change-log";
import { planRegistryAreaFill, registryAreasOf, type RegistryAreaFill, type RegistryAreas } from "@/lib/registry-area";
import { extractHeadTextFromPdf } from "@/lib/pdf-extract";
import { parseRegistryText } from "@/lib/pdf-registry-parser";
import { safeErrorSummary } from "@/lib/safe-error-summary";

export interface FillAreasResult {
  /** 埋めた欄(物件の項目名)。 */
  filled: (keyof RegistryAreaFill)[];
  /** 埋めるはずの欄があったが、編集中の鍵のため見送った。 */
  skippedByEditLock: boolean;
}

const AREA_SELECT = {
  version: true,
  propertyType: true,
  exclusiveAreaRegistry: true,
  landArea: true,
  landAreaMethod: true,
  totalFloorArea: true,
} as const;

const NOTHING: FillAreasResult = { filled: [], skippedByEditLock: false };
/** 面積を読むのに読むページ数・時間の上限。 */
const HEAD_PAGES = 5;
const READ_TIMEOUT_MS = 15_000;

const hasAny = (a: RegistryAreas) => !!(a.unitFloorArea || a.landArea || a.buildingFloorArea);

export async function fillPropertyAreasFromRegistry(args: {
  propertyId: string;
  areas: RegistryAreas;
  changedBy: string;
}): Promise<FillAreasResult> {
  const { propertyId, areas, changedBy } = args;
  if (!hasAny(areas)) return NOTHING;
  const before = await prisma.property.findUnique({ where: { id: propertyId }, select: AREA_SELECT });
  if (!before || Object.keys(planRegistryAreaFill(areas, before)).length === 0) return NOTHING;

  const result = await prisma.$transaction(async (tx) => {
    await lockPropertyRow(tx, propertyId);
    // ⚠ロックの後に読み直す(変更履歴の「変更前」と、空かどうかの判定に使う)。
    const fresh = await tx.property.findUnique({ where: { id: propertyId }, select: AREA_SELECT });
    if (!fresh) return { fill: {}, fresh: null, skipped: false };
    const fill = planRegistryAreaFill(areas, fresh);
    if (Object.keys(fill).length === 0) return { fill: {}, fresh, skipped: false };
    const locked = await isResourceEditLocked(tx, { resourceType: "property", resourceId: propertyId });
    if (locked) return { fill: {}, fresh, skipped: true };
    const written = await tx.property.updateMany({
      where: { id: propertyId, version: fresh.version },
      data: { ...fill, version: { increment: 1 } },
    });
    return { fill: written.count > 0 ? fill : {}, fresh, skipped: false };
  });

  const filled = Object.keys(result.fill) as (keyof RegistryAreaFill)[];
  if (filled.length > 0 && result.fresh) {
    await recordChanges({
      targetTable: "properties",
      targetId: propertyId,
      changedBy,
      oldValues: result.fresh as unknown as Record<string, unknown>,
      newValues: result.fill as Record<string, unknown>,
      trackedFields: PROPERTY_TRACKED_FIELDS,
      source: "pdf_import",
    });
  }
  return { filled, skippedByEditLock: result.skipped };
}

/**
 * 謄本PDFの中身を読んで面積を埋める(添付・一括取込の後に呼ぶ)。**失敗しても投げない**
 * (添付・取込そのものは成功させる)。ログには謄本の中身(住所・氏名)を出さない。
 * ⚠表題部は先頭にあるので先頭の数ページだけ読む・時間の上限つき(超えたら見送る)・読み終えたら後始末
 *   (extractHeadTextFromPdf)。添付の応答を長く止めない(内部レビュー P2)。
 */
export async function fillAreasFromRegistryPdfBestEffort(args: {
  propertyId: string;
  pdf: Buffer;
  changedBy: string;
}): Promise<FillAreasResult> {
  try {
    const text = await extractHeadTextFromPdf(args.pdf, { pages: HEAD_PAGES, timeoutMs: READ_TIMEOUT_MS });
    if (text == null) return NOTHING;
    return await fillPropertyAreasFromRegistry({
      propertyId: args.propertyId,
      areas: registryAreasOf(parseRegistryText(text)),
      changedBy: args.changedBy,
    });
  } catch (e) {
    console.error("registry area fill failed:", safeErrorSummary(e));
    return NOTHING;
  }
}
