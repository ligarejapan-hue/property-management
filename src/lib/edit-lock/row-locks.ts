/**
 * 資源行のロック(所有者側)。
 *
 * ⚠ロック順序規約(edit-lock の保存経路すべてで共有): 所有者 → 物件の親行 → 子行。
 * 物件側の対になるロックは `src/lib/property-record-guard.ts` の `lockPropertyRow`
 * が担う。ここでは所有者側の素のロックだけを1関数に集約する(SQL の重複を防ぐ)。
 *
 * ⚠呼び出し側は必ず「トランザクションの tx」を渡すこと。base client(prisma 既定
 * export)を渡すと、行ロックの外(別コネクション)で以後の判定を行うことになり、
 * このロックが閉じたいはずの TOCTOU の窓が開いたまま残る。
 */

/** $transaction のコールバックが受け取るクライアント($queryRaw だけ使う)。 */
type TxLike = {
  $queryRaw: <T>(query: TemplateStringsArray, ...values: unknown[]) => Promise<T>;
};

export async function lockOwnerRow(tx: TxLike, ownerId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM owners WHERE id = ${ownerId}::uuid FOR UPDATE`;
}

/**
 * 棟の行のロック。棟配下の子(棟の写真)を書き換えるトランザクションの最初に呼び、
 * 同じ棟への書き込みを直列にする(物件配下の `lockPropertyRow` と同じ「親 → 子」の順)。
 * 棟が無ければ何もしない(存在確認は呼び出し側の責務)。
 */
export async function lockBuildingRow(tx: TxLike, buildingId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM buildings WHERE id = ${buildingId}::uuid FOR UPDATE`;
}
