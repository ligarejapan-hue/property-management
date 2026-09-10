/**
 * LP に載せる「図」をアプリが描く(設計 2026-09-08 §2.3)。画像AIは日本語の文字を崩すため、
 * 文字が要る図はここで SVG として描く。純関数・外部参照なし・決定的。
 * すべて viewBox 640x360(4:3 に近い横長)。色は控えめな2色+文字色。
 */
export const FIGURE_KINDS = ["sale_flow", "cost_breakdown", "inheritance_deadlines", "vacant_burden", "timing_by_type"] as const;
export type FigureKind = (typeof FIGURE_KINDS)[number];

export const FIGURE_LABELS: Record<FigureKind, string> = {
  sale_flow: "売却の流れ",
  cost_breakdown: "売却にかかる費用の内訳",
  inheritance_deadlines: "相続した不動産の期限",
  vacant_burden: "空き家のまま持ち続けたときの負担",
  timing_by_type: "種別ごとの売り時の目安",
};

export function isFigureKind(v: unknown): v is FigureKind {
  return typeof v === "string" && (FIGURE_KINDS as readonly string[]).includes(v);
}

const INK = "#1f2937";
const MUTED = "#6b7280";
const ACCENT = "#2e5c8a";
const SOFT = "#e4edf6";
const FONT = 'font-family="\'Hiragino Sans\',\'Noto Sans JP\',\'Yu Gothic\',sans-serif"';

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function wrap(inner: string, title: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" width="640" height="360" role="img" aria-label="${esc(title)}">` +
    `<rect x="0" y="0" width="640" height="360" fill="#ffffff"/>` +
    `<text x="24" y="40" ${FONT} font-size="20" font-weight="700" fill="${INK}">${esc(title)}</text>` +
    inner + `</svg>`;
}
function text(x: number, y: number, s: string, size = 15, fill = INK, anchor = "start", weight = "400"): string {
  return `<text x="${x}" y="${y}" ${FONT} font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;
}

/** 横に並んだ段階(矢印つき) */
function steps(items: string[], y: number, sub?: string[]): string {
  const n = items.length;
  const w = Math.floor((640 - 48 - (n - 1) * 20) / n);
  let out = "";
  items.forEach((label, i) => {
    const x = 24 + i * (w + 20);
    out += `<rect x="${x}" y="${y}" width="${w}" height="64" rx="10" fill="${SOFT}" stroke="${ACCENT}" stroke-width="1.5"/>`;
    out += text(x + w / 2, y + 30, `${i + 1}`, 12, ACCENT, "middle", "700");
    out += text(x + w / 2, y + 50, label, 15, INK, "middle", "700");
    if (sub?.[i]) out += text(x + w / 2, y + 90, sub[i], 12, MUTED, "middle");
    if (i < n - 1) out += `<path d="M${x + w + 4} ${y + 32} l12 0 m-4 -4 l4 4 -4 4" stroke="${ACCENT}" stroke-width="2" fill="none"/>`;
  });
  return out;
}

/**
 * 横棒(割合の目安)。3列 = 見出し / 棒 / 補足。
 * viewBox は 640 幅しかないので、補足(note)は**右端 632 に右寄せ**で置き、棒の右端は
 * 422 で止める(補足に 200px 以上を確保する)。左寄せのまま x=590 に置くと
 * 「価格×3%+6万円+税」のような補足が画面の外まではみ出して切れる(@codex R1 P2)。
 */
const BAR_LABEL_X = 24;
const BAR_X = 232;
const BAR_W = 190; // 棒の右端 = 422。note 領域は 432〜632 の 200px
const NOTE_X = 632;
function bars(rows: Array<[string, number, string]>, y0: number): string {
  let out = "";
  rows.forEach(([label, ratio, note], i) => {
    const y = y0 + i * 48;
    out += text(BAR_LABEL_X, y + 18, label, 14, INK);
    out += `<rect x="${BAR_X}" y="${y}" width="${BAR_W}" height="24" rx="6" fill="${SOFT}"/>`;
    out += `<rect x="${BAR_X}" y="${y}" width="${Math.round(BAR_W * ratio)}" height="24" rx="6" fill="${ACCENT}"/>`;
    out += text(NOTE_X, y + 18, note, 12, MUTED, "end");
  });
  return out;
}

const RENDERERS: Record<FigureKind, () => string> = {
  sale_flow: () =>
    wrap(
      steps(["無料査定", "媒介契約", "販売活動", "売買契約", "引渡し"], 120, ["価格の目安", "販売の依頼", "内見・広告", "条件の合意", "代金と鍵"]) +
      text(24, 300, "目安: 査定から引渡しまで 3〜6か月ほど(物件と条件で変わります)", 13, MUTED),
      FIGURE_LABELS.sale_flow,
    ),
  cost_breakdown: () =>
    wrap(
      bars([
        ["仲介手数料", 0.62, "価格×3%+6万円+税"],
        ["印紙税", 0.06, "契約書に貼付"],
        ["登記費用", 0.1, "抵当権抹消など"],
        ["譲渡所得税", 0.22, "利益が出た場合"],
      ], 84) + text(24, 300, "※割合は目安です。実際の額は物件・条件により異なります", 13, MUTED),
      FIGURE_LABELS.cost_breakdown,
    ),
  inheritance_deadlines: () =>
    wrap(
      `<line x1="48" y1="180" x2="592" y2="180" stroke="${ACCENT}" stroke-width="3"/>` +
      [["相続の開始", 48, "被相続人の死亡"], ["10か月", 240, "相続税の申告・納付"], ["3年", 420, "相続登記の期限(義務)"], ["3年目の年末", 592, "空き家特例の目安"]]
        .map(([label, x, sub]) => `<circle cx="${x}" cy="180" r="8" fill="${ACCENT}"/>` + text(Number(x), 150, String(label), 15, INK, "middle", "700") + text(Number(x), 214, String(sub), 12, MUTED, "middle"))
        .join("") +
      text(24, 300, "※期限は一般的な目安です。個別の事情は専門家にご確認ください", 13, MUTED),
      FIGURE_LABELS.inheritance_deadlines,
    ),
  vacant_burden: () =>
    wrap(
      [["固定資産税・都市計画税", "毎年かかり続ける"], ["管理・草刈り・見回り", "手間と費用"], ["老朽化・修繕", "放置するほど価値が下がる"], ["特定空家の指定", "税の優遇が外れることも"]]
        .map(([t, s], i) => {
          const y = 84 + i * 50;
          return `<rect x="24" y="${y}" width="592" height="40" rx="8" fill="${SOFT}"/>` + text(40, y + 26, t, 15, INK, "start", "700") + text(600, y + 26, s, 13, MUTED, "end");
        }).join("") +
      text(24, 320, "持ち続ける負担と、売却で得られる余裕を比べてみましょう", 13, MUTED),
      FIGURE_LABELS.vacant_burden,
    ),
  timing_by_type: () =>
    wrap(
      bars([
        ["戸建", 0.7, "築年数が浅いほど有利"],
        ["区分マンション", 0.8, "大規模修繕の前後が目安"],
        ["一棟(アパート・マンション)", 0.6, "満室時・利回りが良い時"],
        ["土地", 0.5, "地価と周辺開発の動き"],
      ], 84) + text(24, 300, "※棒の長さは「売りやすさの目安」で、価格を示すものではありません", 13, MUTED),
      FIGURE_LABELS.timing_by_type,
    ),
};

export function renderFigureSvg(kind: FigureKind): string {
  return RENDERERS[kind]();
}
