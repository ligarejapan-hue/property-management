/**
 * 案件ステータスの自動の切り替え(発注者決定 2026-10-20)。
 *
 * - 所有者から申込が届いた(手紙のQR)          → 所有者とやりとり中
 * - 査定報告書を受け取り箱から物件に付けた      → 査定中
 * (一括査定などの反響を貼り付け・Excel で新しく物件にしたときは、作るときの値を
 *  「所有者とやりとり中」にする=ここは通らない。paste/commit を参照)
 *
 * ⚠自動は**前に進むときだけ**。人が手で進めた物件・保留・見送り・他社で決まった物件は
 *   動かさない。そのため「どこからなら動かしてよいか」を切り替え先ごとに許可リストで持つ。
 */
import type { CaseStatus } from "@/generated/prisma";
import { CASE_STATUS_DEPRECATED_MAP, type CaseStatusValue } from "@/lib/property-types";

export type AutoCaseStatusTarget = Extract<CaseStatusValue, "contacting_owner" | "appraisal">;

const AUTO_ALLOWED_FROM: Record<AutoCaseStatusTarget, ReadonlySet<string>> = {
  contacting_owner: new Set(["new_case"]),
  appraisal: new Set(["new_case", "contacting_owner"]),
};

/**
 * いまの値から、自動で `to` に進めてよいか。
 * やめた値(反映の直後に旧版が書いた dm_sent など)は、移し先の値と同じに扱う
 * =移し直しの前に申込が来ても、自動の切り替えを取りこぼさない(@codex #538 R6)。
 */
export function canAutoAdvanceCaseStatus(current: string, to: AutoCaseStatusTarget): boolean {
  const effective = Object.prototype.hasOwnProperty.call(CASE_STATUS_DEPRECATED_MAP, current)
    ? CASE_STATUS_DEPRECATED_MAP[current]
    : current;
  return AUTO_ALLOWED_FROM[to].has(effective);
}

export interface AutoCaseStatusTx {
  property: {
    findUnique: (args: {
      where: { id: string };
      select: { caseStatus: true };
    }) => Promise<{ caseStatus: CaseStatus } | null>;
    updateMany: (args: {
      where: { id: string; caseStatus: CaseStatus };
      data: { caseStatus: AutoCaseStatusTarget };
    }) => Promise<{ count: number }>;
  };
  changeLog: {
    create: (args: {
      data: {
        targetTable: "properties";
        targetId: string;
        fieldName: "caseStatus";
        oldValue: string;
        newValue: AutoCaseStatusTarget;
        source: "auto";
        changedBy: string;
      };
    }) => Promise<unknown>;
  };
}

/**
 * 許されるときだけ案件ステータスを `to` に進め、変更履歴に「自動」で残す。進めたら true。
 * 呼び出し側の tx の中で使う(物件の行を先にロックしている前提)。
 * 書き込みは「読んだ値のままなら」の条件付き=間に人が変えていたら何もしない。
 * ⚠物件の版(version)は**上げない**。上げると、編集ウィンドウを開いている人の保存が
 *   「他のユーザーが先に更新しています」で断られる(編集中の鍵の設計 D9 と同じ理由)。
 *   編集ウィンドウは案件ステータスを送らないので、上げなくても自動の値を上書きしない。
 * changedBy は履歴の記録用(画面では「自動」と出す)。
 */
export async function autoAdvanceCaseStatus(
  tx: AutoCaseStatusTx,
  args: { propertyId: string; to: AutoCaseStatusTarget; changedBy: string },
): Promise<boolean> {
  const row = await tx.property.findUnique({ where: { id: args.propertyId }, select: { caseStatus: true } });
  if (!row || !canAutoAdvanceCaseStatus(row.caseStatus, args.to)) return false;
  const res = await tx.property.updateMany({
    where: { id: args.propertyId, caseStatus: row.caseStatus },
    data: { caseStatus: args.to },
  });
  if (res.count !== 1) return false;
  await tx.changeLog.create({
    data: {
      targetTable: "properties",
      targetId: args.propertyId,
      fieldName: "caseStatus",
      oldValue: row.caseStatus,
      newValue: args.to,
      source: "auto",
      changedBy: args.changedBy,
    },
  });
  return true;
}
