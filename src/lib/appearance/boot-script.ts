import { toNextTheme, type Appearance } from "./options";

// 端末に覚える見た目(ちらつき防止のキャッシュ)。正は DB。テーマの鍵 "theme" は next-themes と同じもの。
export const STORAGE_KEYS = { theme: "theme", density: "pm-density", layout: "pm-layout" } as const;

/**
 * <head> の最初で同期的に走らせる小さなスクリプト(画面を描く前に文字サイズ・レイアウトを付ける)。
 * - ログイン中(server あり): DB の値で端末のキャッシュを上書き → next-themes がそれを読むので色もちらつかない
 * - ログインしていない: 端末に覚えた値を使う
 * - localStorage が使えない環境でも落ちない(サーバーが html に付けた属性がそのまま残る)
 * 値は選択肢から作るので任意の文字は入らないが、念のため JSON にしてから埋め込み、< を逃がす。
 */
export function appearanceBootScript(server: Appearance | null): string {
  const payload = server ? { t: toNextTheme(server.theme), d: server.density, l: server.layout } : null;
  const json = JSON.stringify(payload).replace(/</g, "\\u003c");
  // 端末への書き込み・読み出しは1つずつ別に試す(1つ失敗しても残りを止めない・@codex #618)。
  // ログイン中は DB の値をそのまま使う(端末から読み直さない)。色は next-themes の defaultTheme にも DB の値を渡している。
  return (
    "(function(){" +
    `var s=${json},e=document.documentElement,d=null,l=null;` +
    "function w(k,v){try{window.localStorage.setItem(k,v)}catch(_){}}" +
    "function r(k){try{return window.localStorage.getItem(k)}catch(_){return null}}" +
    `if(s){w("${STORAGE_KEYS.theme}",s.t);w("${STORAGE_KEYS.density}",s.d);w("${STORAGE_KEYS.layout}",s.l);d=s.d;l=s.l;}` +
    `else{d=r("${STORAGE_KEYS.density}");l=r("${STORAGE_KEYS.layout}");}` +
    'if(d==="compact"||d==="normal"||d==="large")e.setAttribute("data-density",d);' +
    'if(l==="side"||l==="top")e.setAttribute("data-layout",l);' +
    "})();"
  );
}
