/** インラインstyle値・<style>埋め込み値から、CSS宣言注入/<style>ブレイクアウトを可能にする文字を除去。
 *  正当な色(#fff, rgb(0,0,0), red)・フォント("Yu Gothic UI",sans-serif)は保持する。 */
export function sanitizeCssValue(value: string): string {
  // 除去: ; { } < > \\ と制御文字（これらが宣言区切り/タグ閉じ/ブロック閉じを可能にする）
  return value.replace(/[;{}<>\\\x00-\x1f]/g, "");
}

/** 画像srcとして安全か（Plan1）: data:image URL のみ許可。/uploads/ 等の root-relative は Plan2 で対応。 */
export function isSafeImageSrc(src: string): boolean {
  return src.startsWith("data:image/");
}
