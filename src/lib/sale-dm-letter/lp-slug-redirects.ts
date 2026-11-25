/**
 * 広告用の公開ページの旧公開名 → 新公開名(固定の対応表)。
 * 公開名を変えたあとも、配ったDM・広告の古い URL を新しい公開名へ恒久転送(308)するためのもの。
 * DMの種類の公開名の解決(lp-public-loader)とは別=ここに載っている名前だけを、DB を読まずに転送する。
 *  - 2026-11-26 発注者: /lp/furuiie → /lp/sumai
 */
export const LP_SLUG_REDIRECTS: Readonly<Record<string, string>> = Object.freeze({
  furuiie: "sumai",
});

const TABLE = new Map(Object.entries(LP_SLUG_REDIRECTS));

/** 旧公開名なら転送先の公開名、そうでなければ null(公開名は小文字に揃えて比べる)。 */
export function lpSlugRedirectTarget(slug: string): string | null {
  return TABLE.get(slug.toLowerCase()) ?? null;
}
