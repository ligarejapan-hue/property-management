/**
 * まとめて反映の「1行(=1物件)」の処理。
 *
 * ⚠**1件ずつのボタンと同じ共通処理**(`applyRegistryOwnersToProperty`)を呼ぶ。
 *   ここの役目は、その結果・エラーを取込記録の行の状態に翻訳することだけ。
 *   守りをここに書き足すと、1件ずつとまとめての挙動がずれる。
 * ⚠1件の失敗で残りを止めない(飛ばして次へ)。何が起きたかは行に残し、
 *   「要確認」の行は後から人が手入力で拾える。
 */
import prisma from "@/lib/prisma";
import { ApiError, type PermissionEntry } from "@/lib/api-helpers";
import { applyRegistryOwnersToProperty } from "@/lib/registry-owner-apply/apply";
import { safeErrorSummary } from "@/lib/safe-error-summary";
import {
  REGISTRY_OWNER_APPLY_JOB_TYPE,
  isRegistryOwnerApplyRow,
  readRegistryOwnerApplyRow,
} from "@/lib/registry-owner-bulk/marker";

export type RegistryOwnerApplyRowOutcome =
  | "success"
  | "skipped"
  | "needs_review"
  | "error"
  | "noop";

/**
 * 行に残すエラー文。
 * ⚠**生のエラー文は出さない**(共通の要約を使う → safe-error-summary.ts)。
 */
function safeErrorMessage(err: unknown): string {
  return `想定外の失敗 (${safeErrorSummary(err)})。管理者に連絡してください`;
}

export async function processRegistryOwnerApplyRow(args: {
  jobId: string;
  rowId: string;
  executor: { id: string; role: string };
  perms: PermissionEntry[];
}): Promise<RegistryOwnerApplyRowOutcome> {
  const { jobId, rowId, executor, perms } = args;

  const row = await prisma.importJobRow.findUnique({ where: { id: rowId } });
  // ⚠未処理の行だけを処理する(再開で二度走らせても二重に入れない)。
  if (!row || row.jobId !== jobId || row.status !== "pending") return "noop";
  const rawData = (row.rawData ?? null) as Record<string, unknown> | null;
  // ⚠印で厳格に見分ける。PDFを上げた一括取込の行をここで処理してはいけない。
  if (!isRegistryOwnerApplyRow(REGISTRY_OWNER_APPLY_JOB_TYPE, rawData)) return "noop";
  const parsed = readRegistryOwnerApplyRow(rawData);
  if (!parsed) return "noop";

  type RowDb = Pick<typeof prisma, "importJobRow">;

  /**
   * 行の状態を書く。⚠**未処理の行だけ**を書き換える(書けた件数を返す)。
   *   確定済みの「成功」を、後から来た失敗で上書きしないため。
   */
  const writeRow = async (
    db: RowDb,
    status: Exclude<RegistryOwnerApplyRowOutcome, "noop">,
    errorMessage: string | null,
    extraRawData?: Record<string, string>,
  ): Promise<number> => {
    const { count } = await db.importJobRow.updateMany({
      where: { id: rowId, jobId, status: "pending" },
      data: {
        status,
        errorMessage,
        ...(extraRawData
          ? {
              rawData: {
                ...(rawData as Record<string, string>),
                ...extraRawData,
              },
            }
          : {}),
      },
    });
    return count;
  };

  const finish = async (
    status: Exclude<RegistryOwnerApplyRowOutcome, "noop">,
    errorMessage: string | null,
    extraRawData?: Record<string, string>,
  ): Promise<RegistryOwnerApplyRowOutcome> =>
    (await writeRow(prisma, status, errorMessage, extraRawData)) > 0 ? status : "noop";

  /**
   * ⚠行の「成功」は、所有者の書き込みと**同じトランザクションの中**で書く。
   *   確定のあとに別の書き込みで記録すると、その間で止まったとき「所有者は入ったのに
   *   行は未処理」になり、再開で「すでに所有者あり=飛ばした」と誤って記録される
   *   (件数がずれる)。
   */
  // ⚠入口が呼ばれた = トランザクションの中で書いただけ。確定(COMMIT)したとは限らない
  //   (確定が失敗すれば所有者も行も巻き戻る)。確定したかは、共通処理が返ったか、
  //   失敗したなら行を読み直して確かめる(@codex 第5R)。
  let rowWrittenInTx = false;
  const rowNoLongerPending = new Error("row is no longer pending");

  try {
    const outcome = await applyRegistryOwnersToProperty({
      session: executor,
      perms,
      propertyId: parsed.propertyId,
      // ⚠まとめて反映は人が中身を見ないので、実行時点の最新の謄本を使う
      //   (共通処理が書き込みのロックの中でも「最新のままか」を確かめる)。
      expectedAttachmentId: undefined,
      beforeCommit: async (tx, summary) => {
        const written = await writeRow(tx, "success", null, {
          // 実際に物件へ紐づいた人数。⚠同じ人が謄本に2回載っていれば1人にまとまるので
          //   読み取った行数とは違いうる。氏名・住所は残さない。
          ownersLinked: String(summary.linked),
        });
        // 別の実行がこの行を先に確定させていた → 所有者の書き込みごと巻き戻す
        if (written === 0) throw rowNoLongerPending;
        rowWrittenInTx = true;
      },
    });
    // 共通処理が返った = トランザクションは確定済み
    if (rowWrittenInTx) return "success";
    // 入口が呼ばれなかった場合(書き込みが無かった等)だけ、ここで記録する
    return await finish("success", null, {
      ownersLinked: String(outcome.result.ownersLinked ?? 0),
    });
  } catch (err) {
    if (err === rowNoLongerPending) return "noop";
    if (rowWrittenInTx) {
      // 確定のあとの後始末(取込ジョブの記録など)で失敗したのか、確定そのものが
      // 失敗したのかを、行を読み直して見分ける。
      // ⚠確定済みなら「成功」を失敗に書き換えない。巻き戻っていれば(未処理のまま)
      //   下で通常どおり失敗として残す。
      try {
        const now = await prisma.importJobRow.findUnique({ where: { id: rowId } });
        if (now?.status === "success") return "success";
      } catch {
        // 読み直せなくても、下の書き込みは未処理の行にしか効かないので安全
      }
    }
    if (err instanceof ApiError) {
      // すでに所有者がいた = この機能の対象外になっただけ(失敗ではない)
      if (err.status === 409 && err.code === "OWNERS_ALREADY_EXIST") {
        return finish("skipped", err.message);
      }
      // 読み取れない・謄本が無い・処理中に別の謄本が添付された
      //   → 人が確かめて手で入れる「要確認」に回す
      if (err.status === 404 || err.status === 422 || err.status === 409) {
        return finish("needs_review", err.message);
      }
      // 権限・担当範囲(403)や 400 は失敗として残す(全行同じ結果になるはずなので、
      // ワーカー側でジョブごと止める判定も別に置いている)
      return finish("error", err.message);
    }
    return finish("error", safeErrorMessage(err));
  }
}
