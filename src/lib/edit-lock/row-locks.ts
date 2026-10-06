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

/**
 * 棟の名前を全部屋へ反映するとき用の、棟の行のロック(`FOR NO KEY UPDATE`)。
 * ⚠`lockBuildingRow`(`FOR UPDATE`)を使わない理由: 物件の保存が `building_id` を書くと、
 * 外部キーの確認で棟の行に `FOR KEY SHARE` が掛かる。`FOR UPDATE` はこれと衝突し、
 * 保存側の `KEY SHARE` の取得を棟の行の持ち主が待たせることになり、待ちの輪になりうる。`FOR NO KEY UPDATE` は `FOR KEY SHARE` と衝突せず、棟どうしの書き込みは直列にできる。
 * ⚠ロック順(システム全体): **部屋の行 → 棟の行**。これを呼ぶ前に部屋の行を取っておくこと
 *   (販売図面の書き戻し・棟の名前の反映とも同じ向き)。
 * 棟が無ければ何もしない(存在確認は呼び出し側の責務)。
 */
export async function lockBuildingRowNoKeyUpdate(tx: TxLike, buildingId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM buildings WHERE id = ${buildingId}::uuid FOR NO KEY UPDATE`;
}
