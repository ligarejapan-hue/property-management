/**
 * 名前に「査定書」「査定報告」が入っているのに種類が「その他」の添付を、種類「査定書・査定報告書」に
 * まとめて直す(2026-11-11 発注者指示)。書類の自動判別ができる前に付けた添付が「その他」のまま残っているため。
 *
 * - 対象: 物件の添付・削除されていない・一般の書類(type=general)・種類なし(その他)・名前が上の語を含む
 *   (判別と同じ比べ方=NFKC・空白除去・小文字)。謄本・受け取り箱の報告書・ほかの種類が付いたものは触らない。
 * - 直し方は画面で種類を選んだときと同じ(段階・種類・そろえた名前・確度=manual)。
 *   物件の行をロックしてから読み直し、まだ「その他」のときだけ書く(画面で同時に直されても上書きしない)。
 * - dry-run(既定)は件数だけ。AuditLog は1件ずつ「種類の code と物件 ID」だけ(ファイル名は残さない)。
 * ⚠出力はファイル名・所在地を出さない(件数と添付の id だけ)。
 */
import { docKindByCode, normalizeForMatch } from "./classify";
import { docColumnsForManualKind } from "./assign";

export const APPRAISAL_KIND = "appraisal_report";

/** 名前で査定書とみなす語(判別の辞書と同じ)。 */
export function isAppraisalFileName(fileName: string): boolean {
  const kind = docKindByCode(APPRAISAL_KIND);
  const name = normalizeForMatch(fileName);
  return !!kind && kind.keywords.some((k) => name.includes(normalizeForMatch(k)));
}

export interface KindBackfillDeps {
  /** 種類なし(その他)の一般の添付(物件・削除されていない)。 */
  listUnclassified: () => Promise<Array<{ id: string; targetId: string; fileName: string }>>;
  /** 1件を直す。直したら true(読み直したらもう種類が付いていた・消えていた等は false)。 */
  setKind: (a: { id: string; targetId: string }) => Promise<boolean>;
  audit: (a: { id: string; targetId: string }) => Promise<void>;
}

export interface KindBackfillReport {
  targets: number;
  changed: number;
  skipped: number;
  failed: string[];
}

export async function backfillAppraisalKind(deps: KindBackfillDeps, opts: { apply: boolean }): Promise<KindBackfillReport> {
  const targets = (await deps.listUnclassified()).filter((a) => isAppraisalFileName(a.fileName));
  const out: KindBackfillReport = { targets: targets.length, changed: 0, skipped: 0, failed: [] };
  if (!opts.apply) return out;
  for (const a of targets) {
    try {
      if (await deps.setKind(a)) {
        out.changed++;
        await deps.audit(a);
      } else {
        out.skipped++;
      }
    } catch {
      out.failed.push(a.id);
    }
  }
  return out;
}

/** 本番の DB に向けた deps(scripts/attachments-appraisal-kind-backfill.ts から使う)。 */
export async function prismaKindBackfillDeps(): Promise<KindBackfillDeps> {
  const { default: prisma } = await import("@/lib/prisma");
  const { lockPropertyRow } = await import("@/lib/property-record-guard");
  const { writeAuditLog } = await import("@/lib/audit");
  const where = { targetType: "property", isDeleted: false, type: "general", docKind: null };
  return {
    listUnclassified: () =>
      prisma.attachment.findMany({ where, select: { id: true, targetId: true, fileName: true }, orderBy: { createdAt: "asc" } }),
    setKind: ({ id, targetId }) =>
      prisma.$transaction(async (tx) => {
        // 物件配下の書き換えは親を先にロック(画面の種類の変更と同じ順・デッドロック回避)。
        await lockPropertyRow(tx, targetId);
        const fresh = await tx.attachment.findFirst({
          where: { id, targetId, ...where },
          select: { fileName: true, docTitle: true, createdAt: true },
        });
        if (!fresh || !isAppraisalFileName(fresh.fileName)) return false;
        const property = await tx.property.findUnique({
          where: { id: targetId },
          select: { buildingName: true, roomNo: true, address: true },
        });
        if (!property) return false;
        const others = await tx.attachment.findMany({
          where: { targetType: "property", targetId, isDeleted: false, docTitle: { not: null }, id: { not: id } },
          select: { docTitle: true },
        });
        const columns = docColumnsForManualKind(
          { kindCode: APPRAISAL_KIND, fileName: fresh.fileName, currentTitle: fresh.docTitle, createdAt: fresh.createdAt },
          {
            property: { buildingName: property.buildingName, roomNo: property.roomNo, address: property.address },
            takenTitles: new Set(others.map((o) => o.docTitle).filter((t): t is string => t !== null)),
          },
        );
        // 読み直した条件(まだ種類なし)のまま書く。
        const r = await tx.attachment.updateMany({ where: { id, ...where }, data: columns });
        return r.count === 1;
      }),
    audit: ({ id, targetId }) =>
      writeAuditLog({
        userId: null,
        action: "update",
        targetTable: "attachments",
        targetId: id,
        detail: { propertyId: targetId, docKind: APPRAISAL_KIND, via: "kind_backfill_script" },
      }),
  };
}
