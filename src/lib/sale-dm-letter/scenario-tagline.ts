/**
 * 社名の横の添え書きを DMの種類ごとに決める(2026-11-08 発注者決定)。手紙(上部の社名の横・署名の下)と
 * ご案内ページ(/t/・/lp/)の両方がここを通る=同じ種類には同じ添え書きを出す。
 * 種類は台帳の autoKey で見分ける(列は足さない)。autoKey の無い種類・種類を使わない発送は「住まい」。
 * ⚠地域名は入れない(都内全域に出す可能性があるため)。
 */
export const DEFAULT_TAGLINE = "住まい・不動産のご相談窓口";

const TAGLINE_BY_AUTO_KEY: Readonly<Record<string, string>> = Object.freeze({
  inheritance: "相続・不動産のご相談窓口",
  inheritance_unit: "相続・不動産のご相談窓口",
  vacant: "空き家・不動産のご相談窓口",
  old_house: DEFAULT_TAGLINE,
});

export function taglineForAutoKey(autoKey: string | null | undefined): string {
  return (autoKey && Object.hasOwn(TAGLINE_BY_AUTO_KEY, autoKey) ? TAGLINE_BY_AUTO_KEY[autoKey] : null) ?? DEFAULT_TAGLINE;
}
