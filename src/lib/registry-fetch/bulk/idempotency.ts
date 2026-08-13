/**
 * 一括取得の「同じ要求か」を表す文字列(冪等キーの張り替え判定 + サーバ側の照合)。
 *
 * ⚠**画面とサーバで同じ材料を使う**のが要点(@codex #373 R9 P2)。
 *   冪等キーは「作成の応答が失われたときに、同じ要求を送り直しても二重に作らない」
 *   ためのもの。材料が足りないと**別の要求を同じ要求とみなす**。
 *
 *   実際に起きる筋道: 作成は成功したのに応答が失われた → 画面はキーを持ったまま
 *   → 利用者がモーダルを閉じ、物件の地番を直して開き直す → 選んだ物件も種別も
 *   同じなのでキーが張り替わらない → サーバは物件を読み直す前に既存ジョブを返す
 *   → **直したはずの物件が対象外のままの古いジョブ**へ飛ばされる。
 *
 *   承認の指紋まで材料に入れておけば、内容が変われば別の要求になる。
 *
 * ⚠材料に入れるのは指紋(digest)であって地番そのものではない(秘匿)。
 */
export function buildBulkIdempotencySignature(
  propertyIds: string[],
  certificateType: string,
  approvedFingerprints?: Record<string, string> | null,
): string {
  // ⚠並びで結果が変わらないようにする(選択の順番は要求の違いではない)。
  const ids = [...propertyIds].sort().join(",");
  const approved = Object.entries(approvedFingerprints ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, hash]) => `${id}:${hash}`)
    .join(",");
  return `${ids}|${certificateType}|${approved}`;
}
