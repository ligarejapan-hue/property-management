/**
 * 登記状況の自動の「取得済」(発注者決定 2026-11-06)。
 *
 * - 物件に謄本(添付の種類 registry)を入れた → 未取得なら取得済に
 * - システムの謄本の取得が成功した → 取得済(切り替え自体は auto-fetch.ts が前からしている。
 *   ここでは変更履歴を残すだけ=logRegistryObtainedByFetch)
 *
 * ⚠上げるだけ・下げない。謄本の添付を消しても取得済のまま。
 * ⚠**「取得中」(scheduled)からは上げない**。取得中は謄本の取得の鍵を兼ねる
 *   (auto-fetch.ts が物件の行のロックの中で scheduled にし、duplicate-guard の already_running が見る)。
 *   取得の最中に添付で取得済にすると鍵が外れ、同じ物件の2回目の購入が通る=二重課金の隙になる。
 *   手で「取得中」にしただけの物件と、取得の最中の物件はDB上で見分けられない
 *   (取得の最中の印はプロセスの中にしか無く、課金後に台帳が書けなかったときは
 *   わざと scheduled のまま残して止める=プロセスが終わっても鍵のことがある)。
 * ⚠物件の版(version)は上げない(案件ステータスの自動と同じ・case-status-auto.ts)。
 *   編集ウィンドウは変えた欄だけ送るので、上げなくても自動の値を上書きしない。
 * ⚠変更履歴には状態の値だけ(所有者名・住所・PDF の中身は入れない)。画面では「自動」と出る。
 */
import prisma from "@/lib/prisma";
import { lockPropertyRow } from "@/lib/property-record-guard";
import type { RegistryStatus } from "@/generated/prisma";

/** いまの登記状況から、自動で取得済に上げてよいか。 */
export function canAutoMarkRegistryObtained(current: string): boolean {
  return current === "unconfirmed";
}

export interface AutoRegistryObtainedTx {
  property: {
    findUnique: (args: {
      where: { id: string };
      select: { registryStatus: true };
    }) => Promise<{ registryStatus: RegistryStatus | string } | null>;
    updateMany: (args: {
      where: { id: string; registryStatus: "unconfirmed" };
      data: { registryStatus: "obtained" };
    }) => Promise<{ count: number }>;
  };
  changeLog: {
    create: (args: { data: RegistryStatusChangeLogData }) => Promise<unknown>;
  };
}

interface RegistryStatusChangeLogData {
  targetTable: "properties";
  targetId: string;
  fieldName: "registryStatus";
  oldValue: string;
  newValue: "obtained";
  source: "auto";
  changedBy: string;
}

function changeLogData(propertyId: string, oldValue: string, changedBy: string): RegistryStatusChangeLogData {
  return {
    targetTable: "properties",
    targetId: propertyId,
    fieldName: "registryStatus",
    oldValue,
    newValue: "obtained",
    source: "auto",
    changedBy,
  };
}

/**
 * 未取得なら取得済に上げ、変更履歴に「自動」で残す。上げたら true。
 * 呼び出し側の tx の中で使う(物件の行を先にロックしている前提)。
 * 書き込みは「未取得のままなら」の条件付き=間に人が変えていたら何もしない。
 */
export async function autoMarkRegistryObtained(
  tx: AutoRegistryObtainedTx,
  args: { propertyId: string; changedBy: string },
): Promise<boolean> {
  const row = await tx.property.findUnique({ where: { id: args.propertyId }, select: { registryStatus: true } });
  if (!row || !canAutoMarkRegistryObtained(row.registryStatus)) return false;
  const res = await tx.property.updateMany({
    where: { id: args.propertyId, registryStatus: "unconfirmed" },
    data: { registryStatus: "obtained" },
  });
  if (res.count !== 1) return false;
  await tx.changeLog.create({ data: changeLogData(args.propertyId, "unconfirmed", args.changedBy) });
  return true;
}

/**
 * 謄本の添付を作り終えたあとに呼ぶ。自分の取引で物件の行をロックしてから上げる。
 * ⚠添付の取引には混ぜない=ここが失敗しても添付は成功のまま(有料取得では添付の失敗が
 *   「課金したのに失敗」になるため)。失敗は記録だけして false。
 */
export async function autoMarkRegistryObtainedBestEffort(args: { propertyId: string; changedBy: string }): Promise<boolean> {
  try {
    return await prisma.$transaction(async (tx) => {
      await lockPropertyRow(tx, args.propertyId);
      return autoMarkRegistryObtained(tx as unknown as AutoRegistryObtainedTx, args);
    });
  } catch (err) {
    console.error("registry-status-auto: 取得済への切り替えに失敗しました", err instanceof Error ? err.message : "unknown");
    return false;
  }
}

/**
 * 謄本の取得が成功して取得済にしたあと、変更履歴を残す(取得の前から取得済なら残さない)。
 * previousStatus は取得の鍵(取得中)を掛ける前の値。
 * ⚠課金後の成功を失敗にしないため、書けなくても投げない。
 */
export async function logRegistryObtainedByFetch(args: {
  propertyId: string;
  previousStatus: string;
  changedBy: string;
}): Promise<void> {
  if (args.previousStatus === "obtained") return;
  try {
    await prisma.changeLog.create({ data: changeLogData(args.propertyId, args.previousStatus, args.changedBy) });
  } catch (err) {
    console.error("registry-status-auto: 変更履歴を残せませんでした", err instanceof Error ? err.message : "unknown");
  }
}
