export interface AssignOptions {
  order?: "sequential" | "random";
  rng?: () => number;
}

export interface ManualAssignment {
  recipientId: string;
  variantId: string;
}

// 各型の本数差が最大1になる「型ラベル列」を recipientIds と同じ長さで作る(ラウンドロビン)。
function evenVariantSequence(count: number, variantIds: string[]): string[] {
  const seq: string[] = [];
  for (let i = 0; i < count; i++) {
    seq.push(variantIds[i % variantIds.length]);
  }
  return seq;
}

// Fisher–Yates(rng 注入可)。入力配列を破壊しないようコピーを返す。
function shuffle<T>(arr: T[], rng: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const k = j > i ? i : j; // rng が 1 を返しても範囲外にしない保険
    [out[i], out[k]] = [out[k], out[i]];
  }
  return out;
}

/**
 * 対象宛先を型へ均等割りする。
 *  - sequential: recipientIds[i] → variantIds[i % n]。端数は先頭型から1つずつ多い。
 *  - random: 本数分布は sequential と同一(均等)のまま、型ラベルの並びだけシャッフル。
 *  - variantIds か recipientIds が空なら空 Map。
 */
export function assignVariantsEvenly(
  recipientIds: string[],
  variantIds: string[],
  opts?: AssignOptions,
): Map<string, string> {
  const map = new Map<string, string>();
  if (variantIds.length === 0 || recipientIds.length === 0) return map;

  let seq = evenVariantSequence(recipientIds.length, variantIds);
  if (opts?.order === "random") {
    seq = shuffle(seq, opts.rng ?? Math.random);
  }
  recipientIds.forEach((rid, i) => map.set(rid, seq[i]));
  return map;
}

/**
 * 手動割当: 指定された (recipientId→variantId) の宛先「のみ」を割り当てる。
 * 未指定の宛先は現状の型を維持(再割当しない=既存 A/B バケットを保全)。
 * 対象 recipientIds / variantIds の集合外の指定は無視する(不正 id を取り込まない)。
 */
export function applyManualAssignment(
  recipientIds: string[],
  variantIds: string[],
  assignments: ManualAssignment[],
): Map<string, string> {
  // 1件の手動変更で他宛先の A/B バケットを書き換えないよう、空 Map から指定分だけ積む。
  const map = new Map<string, string>();
  const recipientSet = new Set(recipientIds);
  const variantSet = new Set(variantIds);
  for (const a of assignments) {
    if (recipientSet.has(a.recipientId) && variantSet.has(a.variantId)) {
      map.set(a.recipientId, a.variantId);
    }
  }
  return map;
}
