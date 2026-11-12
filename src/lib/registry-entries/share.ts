/**
 * 所有者事項の持分(「10分の2」)の読み取りと合計(2026-11-12 発注者決定・純関数)。
 *
 * - 表記は「分母分の分子」(10分の2 = 2/10)。
 * - 合計は**約分しない**(2/10+3/10+2/10=7/10)。分母がそろわないときは通分して足す(1/2+1/4=3/4)。
 * - 持分が読めない行が1つでもあれば合計は出さない(間違った合計を見せない)。
 */

export interface RegistryShare {
  num: number;
  den: number;
}

/** DB の INTEGER(32bit)に入る上限。 */
const MAX_INT = 2_147_483_647;

function toHalfWidthDigits(s: string): string {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/** 「10分の2」→ { num: 2, den: 10 }。読めない・あり得ない(0・1を超える・大きすぎる)は null。 */
export function parseRegistryShare(text: string | null | undefined): RegistryShare | null {
  if (!text) return null;
  const m = toHalfWidthDigits(text)
    .replace(/[\s　,，]/g, "")
    .match(/^(?:持分)?(\d{1,10})分の(\d{1,10})$/);
  if (!m) return null;
  const den = Number(m[1]);
  const num = Number(m[2]);
  if (!Number.isSafeInteger(den) || !Number.isSafeInteger(num)) return null;
  if (den <= 0 || num <= 0 || num > den) return null;
  if (den > MAX_INT || num > MAX_INT) return null;
  return { num, den };
}

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

/**
 * 持分の合計。分母が全部同じならそのまま足す。違えば最小公倍数で通分して足す(約分はしない)。
 * 行が無い・持分の無い行が混じる・合計が1を超える・数が大きすぎる → null。
 */
export function sumRegistryShares(
  shares: ReadonlyArray<RegistryShare | null | undefined>,
): RegistryShare | null {
  if (shares.length === 0) return null;
  let den = 1;
  for (const s of shares) {
    if (!s || s.den <= 0 || s.num <= 0) return null;
    den = (den / gcd(den, s.den)) * s.den;
    if (!Number.isSafeInteger(den) || den > MAX_INT) return null;
  }
  let num = 0;
  for (const s of shares) num += s!.num * (den / s!.den);
  if (!Number.isSafeInteger(num) || num > den) return null;
  return { num, den };
}

/** 画面に出す形(7/10)。 */
export function formatShare(share: RegistryShare): string {
  return `${share.num}/${share.den}`;
}
