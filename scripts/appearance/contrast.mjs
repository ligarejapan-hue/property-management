// 各テーマの文字と背景のコントラスト比を確かめる。使い方: node scripts/appearance/contrast.mjs src/app/globals.css
import { readFileSync } from "node:fs";
const css = readFileSync(process.argv[2], "utf8");
const lum = (h) => { const c = [1,3,5].map(i => parseInt(h.slice(i,i+2),16)/255).map(v => v<=0.03928? v/12.92 : ((v+0.055)/1.055)**2.4); return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2]; };
const cr = (a,b) => { const [x,y]=[lum(a),lum(b)].sort((p,q)=>q-p); return (x+0.05)/(y+0.05); };
for (const m of css.matchAll(/html\[data-theme="(\w+)"\] \{([^}]*)\}/g)) {
  const v = {}; for (const d of m[2].matchAll(/--([\w-]+): (#[0-9a-fA-F]{6});/g)) v[d[1]] = d[2];
  const g = (k) => v[k];
  const checks = [
    ["本文 gray-900/白", g("color-gray-900"), g("color-white"), 4.5],
    ["本文 gray-900/背景50", g("color-gray-900"), g("color-gray-50"), 4.5],
    ["補足 gray-600/白", g("color-gray-600"), g("color-white"), 4.5],
    ["補足 gray-700/白", g("color-gray-700"), g("color-white"), 4.5],
    ["注記 gray-500/白", g("color-gray-500"), g("color-white"), 3],
    ["注記 gray-500/背景50", g("color-gray-500"), g("color-gray-50"), 3],
    ["注記 gray-400/白", g("color-gray-400"), g("color-white"), 3],
    ["注記 gray-400/背景50", g("color-gray-400"), g("color-gray-50"), 3],
    ["主ボタン 白/indigo-600", g("color-white"), g("color-indigo-600"), 4.5],
    ["リンク indigo-600/白", g("color-indigo-600"), g("color-white"), 4.5],
    ["選択中 indigo-700/indigo-50", g("color-indigo-700"), g("color-indigo-50"), 4.5],
    ["サイド 文字/背景", g("side-text"), g("side-bg"), 4.5],
    ["サイド 選択中", g("side-active-text"), g("side-active-bg"), 4.5],
    ["サイド 薄字/背景", g("side-faint"), g("side-bg"), 3],
  ];
  const bad = checks.filter(([, a, b, need]) => cr(a, b) < need).map(([n, a, b, need]) => `${n} ${cr(a,b).toFixed(2)}<${need}`);
  console.log(m[1].padEnd(7), bad.length ? "NG: " + bad.join(" / ") : "OK");
}
