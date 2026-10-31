// 使い方: node scripts/appearance/gen-themes.mjs > /tmp/themes.css → globals.css の @media screen の中の html[data-theme=...] を差し替える。
// 確認: node scripts/appearance/contrast.mjs src/app/globals.css(本文4.5・補足3 を下回る組を出す)。
// 付録A の意味の色から、テーマごとの gray・indigo の11段と white、サイドバーの変数を作って CSS を出す。
// 段の作り方(アプリでの使われ方に合わせる): gray-50=ページ背景 / 100=薄い面 / 200=枠線 / 500=注記 / 700=補足 / 900=本文。
// indigo-50=薄いアクセント / 600=主ボタン / 700=押したとき・アクセントの文字。
const T = {
  blue: {
    bg: "#F6F7F9", surface: "#FFFFFF", surface2: "#F1F3F5", line: "#E3E6EA",
    text: "#16181D", text2: "#4A515C", text3: "#8A919C",
    accent: "#2563EB", accentSoft: "#E8F0FE", accentText: "#2563EB",
    side: { bg: "#FFFFFF", text: "#4A515C", strong: "#16181D", activeBg: "#F1F3F5", activeText: "#16181D", line: "#E3E6EA" },
    logo: "#16181D",
  },
  washi: {
    bg: "#F4F1EA", surface: "#FBF9F4", surface2: "#EFEBE2", line: "#DCD5C8",
    text: "#1C1A17", text2: "#4D473F", text3: "#8C8478",
    accent: "#B7410E", accentSoft: "#F6E5DA", accentText: "#B7410E",
    side: { bg: "#1C1A17", text: "#BDB5A8", strong: "#F4F1EA", activeBg: "#2A2723", activeText: "#F4F1EA", line: "#1C1A17" },
    logo: "#B7410E",
  },
  navy: {
    bg: "#F3F4F7", surface: "#FFFFFF", surface2: "#F1F3F5", line: "#E3E6EA",
    text: "#16181D", text2: "#4A515C", text3: "#8A919C",
    accent: "#1E3A8A", accentSoft: "#E4E9F5", accentText: "#1E3A8A",
    side: { bg: "#0B1F3A", text: "#A9B6CB", strong: "#FFFFFF", activeBg: "#16305A", activeText: "#FFFFFF", line: "#132B4D" },
    logo: "#B08D57", highlight: "#8A6A35",
  },
  forest: {
    bg: "#F2F4F1", surface: "#FFFFFF", surface2: "#EDF1EC", line: "#DCE3DA",
    text: "#18221B", text2: "#46534A", text3: "#85918A",
    accent: "#1F5F3A", accentSoft: "#E1EEE5", accentText: "#1F5F3A",
    side: { bg: "#16301F", text: "#9FB7A6", strong: "#FFFFFF", activeBg: "#24462F", activeText: "#FFFFFF", line: "#16301F" },
    logo: "#DDEBDF",
  },
  paper: {
    bg: "#F3EEE6", surface: "#FFFDF9", surface2: "#F1EBE1", line: "#E2D8CA",
    text: "#2B241E", text2: "#5A4F45", text3: "#968A7D",
    accent: "#9A3B12", accentSoft: "#F5E4D8", accentText: "#9A3B12",
    side: { bg: "#EDE6DB", text: "#5A4F45", strong: "#2B241E", activeBg: "#FFFDF9", activeText: "#2B241E", line: "#E2D8CA" },
    logo: "#2B241E",
  },
};

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const toHex = (c) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
const mix = (a, b, t) => toHex(hex(a).map((v, i) => v + (hex(b)[i] - v) * t));
const lum = (h) => {
  const c = hex(h).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
// 注記(gray-400)は白い面とページの背景の両方で 3:1 以上(段階4 の確認で 2.3〜2.6 だった)。線の色から注記の色へ寄せ、
// 足りなければ補足の色(text2)の方へ少しずつ濃くする。
const faintText = (t) => {
  let c = mix(t.line, t.text3, 0.7);
  for (let k = 0.05; ratio(c, t.surface) < 3.05 || ratio(c, t.bg) < 3.05; k += 0.05) c = mix(t.text3, t.text2, k);
  return c;
};

const out = [];
for (const [name, t] of Object.entries(T)) {
  const g = {
    50: t.bg, 100: t.surface2, 200: t.line,
    300: mix(t.line, t.text3, 0.35), 400: faintText(t), 500: mix(t.text3, t.text2, 0.12),
    600: mix(t.text3, t.text2, 0.55), 700: t.text2, 800: mix(t.text2, t.text, 0.5), 900: t.text,
    950: mix(t.text, "#000000", 0.3),
  };
  const a = t.accent;
  const deeper = t.accentText.toLowerCase() === a.toLowerCase() ? mix(a, "#000000", 0.15) : t.accentText;
  const i = {
    50: t.accentSoft, 100: mix(t.accentSoft, a, 0.12), 200: mix(t.accentSoft, a, 0.3), 300: mix(t.accentSoft, a, 0.5),
    400: mix(t.accentSoft, a, 0.72), 500: mix(t.accentSoft, a, 0.88), 600: a, 700: deeper,
    800: mix(a, "#000000", 0.3), 900: mix(a, "#000000", 0.45), 950: mix(a, "#000000", 0.6),
  };
  const s = t.side;
  const lines = [];
  lines.push(`  html[data-theme="${name}"] {`);
  for (const k of Object.keys(g)) lines.push(`    --color-gray-${k}: ${g[k]};`);
  for (const k of Object.keys(i)) lines.push(`    --color-indigo-${k}: ${i[k]};`);
  lines.push(`    --color-white: ${t.surface};`);
  lines.push(`    --side-bg: ${s.bg};`, `    --side-text: ${s.text};`, `    --side-strong: ${s.strong};`,
    `    --side-active-bg: ${s.activeBg};`, `    --side-active-text: ${s.activeText};`, `    --side-line: ${s.line};`,
    `    --side-hover-bg: ${s.activeBg};`, `    --side-hover-text: ${s.strong};`, `    --side-muted: ${s.text};`,
    `    --side-faint: ${mix(s.text, s.bg, 0.25)};`, `    --side-icon: ${mix(s.text, s.bg, 0.25)};`, `    --side-muted-hover: ${s.strong};`,
    `    --logo-bg: ${t.logo};`);
  if (t.highlight) lines.push(`    --highlight: ${t.highlight};`);
  lines.push(`  }`);
  out.push(lines.join("\n"));
}
console.log(out.join("\n"));
