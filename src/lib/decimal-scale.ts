/**
 * 小数の桁数(scale)を調べる小さな道具。
 *
 * [@codex P2] PostgreSQL の DECIMAL(p,s) 列は、桁数を超える値を**黙って丸めて**格納する。
 * 検証が範囲(min/max)しか見ていないと、例えば DECIMAL(12,1) の価格に 1.25 を保存した
 * とき、DB には 1.3 が入るのに変更履歴・図面・画面には 1.25 が残り、どれが本当の値か
 * 分からなくなる。保存前にこの関数で桁数を確かめ、超えるものは受け付けない。
 */

/**
 * 有限数の小数点以下の桁数を返す(末尾の 0 は数えない)。
 * 無限大・NaN は Infinity を返す(= どんな上限にも収まらない)。
 *
 * 指数表記になる極端な値(1e-7 など)も正しく数えるため、文字列の "." を数えるのではなく
 * toExponential() の仮数部と指数から求める。
 */
export function decimalScale(n: number): number {
  if (!Number.isFinite(n)) return Infinity;
  if (Number.isInteger(n)) return 0;
  const [mantissa, expPart] = n.toExponential().split("e");
  const fractionDigits = (mantissa.split(".")[1] ?? "").replace(/0+$/, "").length;
  return Math.max(0, fractionDigits - Number(expPart));
}

/** 小数点以下が scale 桁以内か(列の DECIMAL(p,s) の s を渡す)。 */
export function fitsDecimalScale(n: number, scale: number): boolean {
  return decimalScale(n) <= scale;
}
