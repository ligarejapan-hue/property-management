/**
 * 「承認したときに警告が無かったもの」を、課金を直列化するロックと**同じ一文**で検査する条件。
 *
 * ⚠なぜ要るか（@codex #399 R5 P2）: 画面が課金の直前に取り直す警告は**別の問い合わせ**なので、
 *   相手の処理（謄本PDFの添付・所有者の紐付け）がまだ確定していない一瞬に読むと
 *   「警告なし」と返る。その直後に相手が確定すると、**既にある謄本をもう一度買ってしまう**。
 *   条件をロックの一文に混ぜれば、相手が物件行を押さえている間はこちらが待たされ、
 *   相手の確定後に条件が評価し直されて弾ける（物件配下の書き込みは親行を先にロックする規約）。
 * ⚠**承認した項目だけ**を条件にする。警告を見たうえで意図して買い直す運用は従来どおり許す
 *   （事前警告は「警告のみ・実行はブロックしない」設計）。
 */
export interface ApprovedPreflightFlags {
  /** 承認時、登記状況が「取得済」だったか。 */
  registryObtained: boolean;
  /** 承認時、謄本PDF(未削除)が添付されていたか。 */
  hasRegistryAttachment: boolean;
  /** 承認時、所有者が1名以上いたか。 */
  hasOwners: boolean;
}

/** ⚠Prisma の列挙型に合わせる（string[] だと where に渡せない）。 */
export type BlockedRegistryStatus = "scheduled" | "obtained";

export interface ApprovedDuplicateGuard {
  registryStatus?: { notIn: BlockedRegistryStatus[] };
  attachments?: { none: { targetType: string; type: string; isDeleted: boolean } };
  propertyOwners?: { none: Record<string, never> };
}

export function buildApprovedDuplicateGuard(
  approved: ApprovedPreflightFlags | null | undefined,
): ApprovedDuplicateGuard {
  if (!approved) return {};
  const guard: ApprovedDuplicateGuard = {};
  if (!approved.registryObtained) {
    // ⚠既存の二重実行ガード(scheduled を除く)を**弱めない**よう、両方を外す。
    guard.registryStatus = { notIn: ["scheduled", "obtained"] as BlockedRegistryStatus[] };
  }
  if (!approved.hasRegistryAttachment) {
    // ⚠事前確認(preflight)と**同じ述語**にする。片方だけ変えるとずれる。
    guard.attachments = {
      none: { targetType: "property", type: "registry", isDeleted: false },
    };
  }
  if (!approved.hasOwners) {
    guard.propertyOwners = { none: {} };
  }
  return guard;
}
