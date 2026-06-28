/** インラインstyle値・<style>埋め込み値から、CSS宣言注入/<style>ブレイクアウトを可能にする文字を除去。
 *  正当な色(#fff, rgb(0,0,0), red)・フォント("Yu Gothic UI",sans-serif)は保持する。 */
export function sanitizeCssValue(value: string): string {
  // 除去: ; { } < > \\ と制御文字（これらが宣言区切り/タグ閉じ/ブロック閉じを可能にする）
  return value
    .replace(/[;{}<>\\\x00-\x1f]/g, "")
    .replace(/url\s*\(/gi, "")   // neutralize background:url(...) fetch (SSRF); no legit color/font uses url()
    .replace(/@import/gi, "");
}

/**
 * 画像srcとして安全か（Plan3確定版）: 以下の2種のみ許可。
 *
 * 1. data:image/ — base64埋め込み画像。
 * 2. /uploads/ ルート相対パス — アプリ内蔵ストレージへの参照。
 *    安全な理由:
 *      - アプリ専用パス。外部ホストへのSSRF/exfilは起こらない。
 *      - `/uploads/[...path]` route がサーブ時にアクセス権を確認する（認可バイパスは是正済）。
 *      - エクスポート経路(Task C)でサーバーが再認可＋data:展開してからChromiumに渡す。
 *      - 非data: srcをChromiumがネットワークレベルでブロックする追加防御もある。
 *
 * 拒否する代表ケース:
 *   // (プロトコル相対) / http: https: javascript: など任意scheme /
 *   バックスラッシュ / .. (パストラバーサル) / 空白・制御文字 / < > 引用符 /
 *   /uploads で終わるだけで / がない接頭辞一致 / data:image/ 以外の data:
 */

/**
 * /uploads/ ルート相対パスの検証正規表現。
 *   ^ \/uploads\/  — 先頭が必ず "/uploads/"（単一スラッシュ＋"uploads/"）
 *   [^\x00-\x20\x7f\\<>"']+  — 残りは制御文字・空白(U+0000–U+0020)・DEL・
 *                               バックスラッシュ・山括弧・引用符を含まない1文字以上
 *   $
 * ".." チェックは別途 !src.includes("..") で行う（正規表現で書くより明確）。
 */
const UPLOADS_SRC_RE = /^\/uploads\/[^\x00-\x20\x7f\\<>"']+$/;

export function isSafeImageSrc(src: string): boolean {
  // 1. data:image/ （既存の許可: base64埋め込み画像）
  if (src.startsWith("data:image/")) return true;

  // 2. /uploads/ ルート相対パス
  //    UPLOADS_SRC_RE が先頭の "//" (プロトコル相対) を拒否する点に注意:
  //    "^\/uploads\/" は単一の "/" から始まるため "//..." にはマッチしない。
  if (UPLOADS_SRC_RE.test(src) && !src.includes("..")) return true;

  return false;
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
