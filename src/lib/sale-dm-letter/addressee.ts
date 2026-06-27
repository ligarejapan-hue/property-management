// 宛名敬称の合成(純粋関数・サーバー依存なし=client/server 双方から import 可能なリーフモジュール)。
// 送付先が複数共有者(coOwnerCount>1)なら代表者の base 敬称(様/御中)に「他共有者様」を付す。
// 印刷/CSV/承認プレビューを同一整形にし、承認時に見た宛名と実際に郵送する宛名を一致させる。
// draft は base 敬称と coOwnerCount を別々に保存し、表示時にここで合成する(prompt 側の二重付与を防ぐ)。
export const OTHER_CO_OWNERS_SUFFIX = "他共有者様";

export function composeAddresseeHonorific(honorific: string, coOwnerCount: number): string {
  return coOwnerCount > 1 ? `${honorific} ${OTHER_CO_OWNERS_SUFFIX}` : honorific;
}
