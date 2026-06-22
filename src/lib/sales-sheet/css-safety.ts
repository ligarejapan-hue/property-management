/** インラインstyle値・<style>埋め込み値から、CSS宣言注入/<style>ブレイクアウトを可能にする文字を除去。
 *  正当な色(#fff, rgb(0,0,0), red)・フォント("Yu Gothic UI",sans-serif)は保持する。 */
export function sanitizeCssValue(value: string): string {
  // 除去: ; { } < > \\ と制御文字（これらが宣言区切り/タグ閉じ/ブロック閉じを可能にする）
  return value
    .replace(/[;{}<>\\\x00-\x1f]/g, "")
    .replace(/url\s*\(/gi, "")   // neutralize background:url(...) fetch (SSRF); no legit color/font uses url()
    .replace(/@import/gi, "");
}

/** 画像srcとして安全か（Plan1）: data:image URL のみ許可。/uploads/ 等の root-relative は Plan2 で対応。 */
export function isSafeImageSrc(src: string): boolean {
  return src.startsWith("data:image/");
}

const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;
const FN_COLOR = /^(?:rgb|rgba|hsl|hsla)\([0-9.,%/\s]+\)$/i; // only numeric content inside the parens
const KEYWORD_COLOR = /^[a-zA-Z]+$/; // named color / transparent / currentColor (inert, cannot fetch)
/** CSS色として安全か（許可リスト）: hex / rgb()/rgba()/hsl()/hsla()(数値のみ) / 単語キーワード のみ許可。url()/image-set()/宣言区切り等は拒否。 */
export function isCssColor(v: string): boolean {
  return HEX_COLOR.test(v) || FN_COLOR.test(v) || KEYWORD_COLOR.test(v);
}

/** font-family として安全か（許可リスト）: 英数/空白/カンマ/ハイフン/アンダースコア/引用符/日本語 のみ。括弧・コロン・スラッシュ・タグ・宣言区切りを許さない（url()/image-set()/</style>を拒否）。 */
const SAFE_FONT = /^[A-Za-z0-9 ,\-_'"　-ヿ一-鿿＀-￯]+$/;
export function isSafeFontFamily(v: string): boolean {
  return SAFE_FONT.test(v);
}
