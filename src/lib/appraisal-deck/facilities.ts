/**
 * 査定報告書(SRE)の「周辺施設情報」から、周辺施設の種類・名前・距離・徒歩分と、物件から見た位置を読む(2026-11-11)。
 *
 * - 表(「最寄りの各種施設」)の行: 番号・種類・名前・直線距離(m)・推定徒歩(分)。
 * - 同じページの地図には、施設ごとのアイコン(小さな画像)と物件の印が置かれている。アイコンの色で種類を見分け、
 *   物件の印からの向きと、表の直線距離から求めた縮尺で、物件から東西・南北の何 m かを出す。
 * - 縮尺がそろわない(=地図の作りが違う)・アイコンが見つからない施設は位置なし(一覧だけに出す)。
 * ⚠資料の演出用の目安。施設情報の出所(ナビタイムジャパン)を資料に書く。
 */
import { normalizeSreText, type DeckFacility } from "./parse";

/** worker が返すページの中身(座標は PDF の点・y は上向き。アイコンは下の真ん中=地図上の地点)。 */
export interface FacilityPageRaw {
  lines: string[];
  icons: Array<{ x: number; y: number; rgb: [number, number, number] | null }>;
}

export const PROPERTY_MARK = "査定物件";

/** SRE の地図の凡例の色(実物の報告書から読んだもの)。 */
export const SRE_ICON_COLORS: Record<string, [number, number, number]> = {
  [PROPERTY_MARK]: [185, 34, 34],
  コンビニ: [255, 111, 0],
  スーパー: [222, 68, 0],
  "薬局・ドラッグストア": [255, 178, 74],
  "100円ショップ・ディスカウントストア": [226, 190, 40],
  "ホームセンター・日用雑貨": [196, 138, 6],
  大型ショッピング施設: [168, 63, 63],
  総合病院: [0, 186, 255],
  内科: [0, 119, 255],
  "形成/整形外科": [38, 59, 221],
  耳鼻咽喉科: [66, 117, 214],
  眼科: [10, 101, 162],
  皮膚科: [38, 156, 214],
  "神経科/精神科": [40, 104, 232],
  産婦人科: [214, 101, 255],
  小児科: [96, 194, 255],
  救急指定病院: [224, 50, 224],
  "接骨院/整骨院": [71, 0, 204],
  歯科: [171, 72, 255],
  介護サービス: [241, 94, 253],
  "幼稚園・保育園": [162, 217, 74],
  ベビー用品: [0, 230, 76],
  小学校: [9, 193, 150],
  中学校: [21, 192, 206],
  銀行: [60, 89, 128],
  郵便局: [74, 142, 57],
  図書館: [219, 63, 117],
  "役所・公民館": [170, 20, 20],
  "警察署・交番": [255, 178, 74],
  消防署: [234, 82, 82],
  公園: [62, 178, 0],
  フィットネス: [11, 214, 240],
};

const CATEGORIES = Object.keys(SRE_ICON_COLORS)
  .filter((k) => k !== PROPERTY_MARK)
  .sort((a, b) => b.length - a.length);

const norm = (s: string) => normalizeSreText(s).replace(/\s+/g, " ").trim();

/** 表の行(「1 コンビニ デイリーヤマザキ 目黒本町6丁目店 150 m 2 分」の形)を読む。 */
export function parseFacilityRows(lines: string[]): Array<Omit<DeckFacility, "x" | "y">> {
  const out: Array<Omit<DeckFacility, "x" | "y">> = [];
  const start = lines.findIndex((l) => norm(l).replace(/\s/g, "").includes("最寄りの各種施設"));
  if (start < 0) return out;
  for (const raw of lines.slice(start + 1)) {
    const l = norm(raw);
    const m = /^(\d{1,2})\s*(.+?)\s*(\d{1,5})\s*m\s*(\d{1,3})\s*分$/.exec(l);
    if (!m) continue;
    const body = m[2];
    const cat = CATEGORIES.find((c) => body.replace(/\s/g, "").startsWith(c.replace(/\s/g, "")));
    if (!cat) continue;
    // 種類の文字数ぶん(空白を除いて数えて)先頭を落とした残りが名前
    let i = 0;
    let n = 0;
    const want = cat.replace(/\s/g, "").length;
    while (i < body.length && n < want) {
      if (!/\s/.test(body[i])) n++;
      i++;
    }
    const name = body.slice(i).trim().slice(0, 60);
    if (!name) continue;
    out.push({ cat, name, dist: Number(m[3]), min: Number(m[4]) });
    if (out.length >= 30) break;
  }
  return out;
}

/**
 * アイコンの色 → 当てはまる種類(凡例の色に近いもの)。遠ければ空。
 * ⚠凡例で同じ色の種類がある(薬局・ドラッグストアと警察署・交番)。その場合は両方を返し、
 *   どちらの施設かは表の距離で決める(@codex #707)。
 */
export function classifyIconColor(rgb: [number, number, number] | null): string[] {
  if (!rgb) return [];
  const ds = Object.entries(SRE_ICON_COLORS).map(([k, c]) => [k, Math.hypot(c[0] - rgb[0], c[1] - rgb[1], c[2] - rgb[2])] as const);
  const bd = Math.min(...ds.map(([, d]) => d));
  if (bd > 40) return [];
  return ds.filter(([, d]) => d - bd < 1).map(([k]) => k);
}

/** 凡例で色が同じ種類を持つか(=色だけでは見分けられない)。 */
const AMBIGUOUS = new Set(
  Object.entries(SRE_ICON_COLORS)
    .filter(([k, c]) => Object.entries(SRE_ICON_COLORS).some(([k2, c2]) => k2 !== k && c2.every((v, i) => v === c[i])))
    .map(([k]) => k),
);

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** 表の行と地図のアイコンから、施設の位置(物件から東西 x・南北 y の m)を求める。 */
export function locateFacilities(raw: FacilityPageRaw): DeckFacility[] {
  const rows = parseFacilityRows(raw.lines);
  const icons = raw.icons.map((i, idx) => ({ ...i, idx, cats: classifyIconColor(i.rgb) }));
  const props = icons.filter((i) => i.cats.length === 1 && i.cats[0] === PROPERTY_MARK);
  const none = rows.map((r) => ({ ...r, x: null, y: null }));
  if (rows.length === 0 || props.length !== 1) return none;
  const P = props[0];
  const pd = (i: { x: number; y: number }) => Math.hypot(i.x - P.x, i.y - P.y);
  // 縮尺(1点あたりの m)= 表の距離 ÷ 同じ種類で一番近いアイコンまでの点の数。種類ごとの値がそろっていること
  // 縮尺は色で見分けられる種類だけで求める
  const ratios = rows
    .filter((r) => !AMBIGUOUS.has(r.cat))
    .map((r) => {
      const ds = icons.filter((i) => i.cats.length === 1 && i.cats[0] === r.cat).map(pd).filter((d) => d > 0.5);
      return ds.length ? r.dist / Math.min(...ds) : null;
    })
    .filter((v): v is number => v !== null && Number.isFinite(v));
  if (ratios.length < 3) return none;
  const sc = median(ratios);
  const agree = ratios.filter((v) => Math.abs(v - sc) / sc < 0.1).length;
  if (agree < Math.max(3, ratios.length * 0.6)) return none;

  // 色で見分けられる種類から先に決め、使ったアイコンは他の施設に使わない。同じ色の種類は、残ったアイコンのうち
  // 距離がよく合うもの(誤差 10m か 8% 以内)だけ=合わなければ位置なし(違う施設の場所に置かない)
  const used = new Set<number>();
  const pos = new Map<number, { x: number; y: number }>();
  const order = rows.map((r, i) => i).sort((a, b) => Number(AMBIGUOUS.has(rows[a].cat)) - Number(AMBIGUOUS.has(rows[b].cat)));
  for (const ri of order) {
    const r = rows[ri];
    const amb = AMBIGUOUS.has(r.cat);
    let best: (typeof icons)[number] | null = null;
    let err = Infinity;
    for (const c of icons) {
      if (used.has(c.idx) || !c.cats.includes(r.cat)) continue;
      const e = Math.abs(pd(c) * sc - r.dist);
      if (e < err) {
        err = e;
        best = c;
      }
    }
    const tol = amb ? Math.max(10, r.dist * 0.08) : Math.max(15, r.dist * 0.15);
    if (!best || err > tol) continue;
    used.add(best.idx);
    // PDF の y は上向き=北が + のまま
    pos.set(ri, { x: Math.round((best.x - P.x) * sc), y: Math.round((best.y - P.y) * sc) });
  }
  return rows.map((r, i) => ({ ...r, x: pos.get(i)?.x ?? null, y: pos.get(i)?.y ?? null }));
}
