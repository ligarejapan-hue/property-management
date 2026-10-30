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
  return (
    "(function(){try{" +
    `var s=${json},ls=window.localStorage,e=document.documentElement;` +
    `if(s){ls.setItem("${STORAGE_KEYS.theme}",s.t);ls.setItem("${STORAGE_KEYS.density}",s.d);ls.setItem("${STORAGE_KEYS.layout}",s.l);}` +
    `var d=ls.getItem("${STORAGE_KEYS.density}"),l=ls.getItem("${STORAGE_KEYS.layout}");` +
    'if(d==="compact"||d==="normal"||d==="large")e.setAttribute("data-density",d);' +
    'if(l==="side"||l==="top")e.setAttribute("data-layout",l);' +
    "}catch(_){}})();"
  );
}
