/**
 * justified-pack.ts
 *
 * 写真の「段組み詰め」(justified layout)。各写真の実寸縦横比で枠を作り、
 * 行ごとに高さを合わせて幅Wぴったりに敷き詰める(Google写真のアルバム方式)。
 * 枠=写真の形なので枠内の余白(letterbox)が出ない=「左2/3を無駄なく使う」の中核。
 *
 * - 入力順を保存(読み順で行へ流し込む)。
 * - 行分割: k=1..n の各行数について linear-partition DP(行のΣaspect最大を最小化=
 *   行高さの均一化)し、無駄面積(W·H−写真面積合計)が最小の k を採用。
 * - 総高が H を超える分割は全行を等率縮小して収める(比率不変・右/下に余り)。
 * - 純・決定的・副作用なし。
 */

/** 全分割が成立しない極小ゾーンで返す寸法の下限(mm)。非正寸法を絶対に返さない。 */
const MIN_DIM_MM = 0.5;

export interface PackedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * aspects[i] = 写真 i の縦横比(width/height・正数)。
 * 戻り値は同じ順序の枠(ゾーン原点(0,0)基準・mm)。
 */
export function packJustifiedRows(
  aspects: number[],
  W: number,
  H: number,
  gap: number,
): PackedRect[] {
  const n = aspects.length;
  if (n === 0) return [];
  // 非正の比は 4:3 に矯正(ゼロ除算/負寸法の防止)。
  const a = aspects.map((v) => (Number.isFinite(v) && v > 0 ? v : 4 / 3));

  let best: { rects: PackedRect[]; waste: number; k: number } | null = null;

  for (let k = 1; k <= n; k++) {
    const breaks = linearPartition(a, k);
    const rects = layoutRows(a, breaks, W, H, gap);
    // 非正寸法を含む分割は候補から除外(H が行間gapより小さい等で scale が負になる分割。
    // 負×負=正で「使用面積」が大きく見え最良候補に化けるのを防ぐ・packPhotoCells と同方針)。
    if (rects.some((r) => r.w <= 0 || r.h <= 0)) continue;
    const used = rects.reduce((s, r) => s + r.w * r.h, 0);
    const waste = W * H - used;
    if (!best || waste < best.waste - 1e-9) best = { rects, waste, k };
  }
  if (best) return best.rects;
  // 全分割が不可(W/H が極小)。非正寸法を返さないことを最優先に、1行で
  // 高さを微小正値にクランプして返す(呼び出し側はゾーン極小時に呼ばない想定のガード)。
  const h = Math.max(MIN_DIM_MM, (W - (n - 1) * gap) / a.reduce((s2, v) => s2 + v, 0));
  let x = 0;
  return a.map((v) => {
    const r = { x, y: 0, w: Math.max(MIN_DIM_MM, v * h), h };
    x += r.w + gap;
    return r;
  });
}

/**
 * a を k 個の連続グループへ、グループΣの最大を最小化して分割(古典 linear partition DP)。
 * 戻り値 = 各グループの終端 index(exclusive)の列(長さ k・末尾は n)。同点は前寄り分割。
 */
function linearPartition(a: number[], k: number): number[] {
  const n = a.length;
  if (k >= n) return a.map((_, i) => i + 1); // 1枚1行
  const prefix = [0];
  for (let i = 0; i < n; i++) prefix.push(prefix[i] + a[i]);
  const sum = (i: number, j: number) => prefix[j] - prefix[i]; // [i, j)

  // dp[g][i] = 先頭 i 枚を g グループに分けた時の最大グループΣの最小値
  const INF = Number.POSITIVE_INFINITY;
  const dp: number[][] = Array.from({ length: k + 1 }, () => new Array<number>(n + 1).fill(INF));
  const cut: number[][] = Array.from({ length: k + 1 }, () => new Array<number>(n + 1).fill(0));
  dp[0][0] = 0;
  for (let g = 1; g <= k; g++) {
    for (let i = g; i <= n; i++) {
      // 最後のグループを [j, i) とする
      for (let j = g - 1; j < i; j++) {
        const cost = Math.max(dp[g - 1][j], sum(j, i));
        if (cost < dp[g][i] - 1e-12) {
          dp[g][i] = cost;
          cut[g][i] = j;
        }
      }
    }
  }
  // 復元
  const ends: number[] = new Array(k);
  let i = n;
  for (let g = k; g >= 1; g--) {
    ends[g - 1] = i;
    i = cut[g][i];
  }
  return ends;
}

/** 分割に従って各行の高さ・矩形を計算。総高が H を超える場合は全行を等率縮小。 */
function layoutRows(
  a: number[],
  ends: number[],
  W: number,
  H: number,
  gap: number,
): PackedRect[] {
  const k = ends.length;
  // 行ごとの自然高: rowH = (W − (c−1)·gap) / Σaspect
  const rowsMeta: { start: number; end: number; h: number }[] = [];
  let start = 0;
  for (const end of ends) {
    const c = end - start;
    const sumA = a.slice(start, end).reduce((s, v) => s + v, 0);
    const h = (W - (c - 1) * gap) / sumA;
    rowsMeta.push({ start, end, h });
    start = end;
  }
  const contentH = rowsMeta.reduce((s, r) => s + r.h, 0);
  const totalH = contentH + (k - 1) * gap;
  const scale = totalH > H ? (H - (k - 1) * gap) / contentH : 1;

  const rects: PackedRect[] = [];
  let y = 0;
  for (const row of rowsMeta) {
    const h = row.h * scale;
    let x = 0;
    for (let i = row.start; i < row.end; i++) {
      const w = a[i] * h;
      rects.push({ x, y, w, h });
      x += w + gap;
    }
    y += h + gap;
  }
  return rects;
}
