/**
 * LP に載せる「図」をアプリが描く(設計 2026-09-08 §2.3)。画像AIは日本語の文字を崩すため、
 * 文字が要る図はここで SVG として描く。純関数・外部参照なし・決定的。
 * すべて viewBox 640x360(4:3 に近い横長)。色は控えめな2色+文字色。
 */
import { LP_BRAND, type LpBrandImage } from "./lp-brand";

export const FIGURE_KINDS = ["sale_flow", "cost_breakdown", "inheritance_deadlines", "vacant_burden", "timing_by_type", "sell_rent_keep", "partner_network", "consult_guide"] as const;
export type FigureKind = (typeof FIGURE_KINDS)[number];

export const FIGURE_LABELS: Record<FigureKind, string> = {
  sale_flow: "売却の流れ",
  cost_breakdown: "売却にかかる費用の内訳",
  inheritance_deadlines: "相続した不動産の期限",
  vacant_burden: "空き家のまま持ち続けたときの負担",
  timing_by_type: "種別ごとの売り時の目安",
  sell_rent_keep: "売る・貸す・しばらく持つ(絵つきの札)",
  partner_network: "窓口はひとつ(提携先の図)",
  consult_guide: "案内役(イメージイラスト)と本文",
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

/**
 * 相続の期限(時間軸)の目盛り。[見出し, 目盛りの x, 補足]。
 * ⚠**最後の目盛りだけは文字を右端に寄せる**。中央寄せのままだと 12px の補足
 * 「空き家特例の目安」(8文字 ≒ 96px)の右端が 592+48 = 640 = viewBox の縁に
 * ちょうど触れて切れて見える。end 寄せ・x=632 なら右に 8px の余白が残る。
 * (丸は目盛りの位置 592 のまま。文字だけを内側へ寄せる)
 */
const DEADLINE_MARKS: Array<[label: string, x: number, sub: string]> = [
  ["相続の開始", 48, "亡くなった日"],
  ["原則10か月", 240, "相続税の申告・納付"],
  ["原則3年", 420, "相続登記の申請"],
  ["売却期限", 592, "空き家特例(条件あり)"],
];
const DEADLINE_LAST_TEXT_X = 632;

const RENDERERS: Record<FigureKind, () => string> = {
  sale_flow: () =>
    wrap(
      steps(["無料査定", "家族で相談", "販売の依頼", "販売・契約", "引渡し"], 120, ["価格の目安", "急かしません", "媒介契約", "内見・条件", "代金と鍵"]) +
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
      DEADLINE_MARKS
        .map(([label, x, sub], i) => {
          const last = i === DEADLINE_MARKS.length - 1;
          const tx = last ? DEADLINE_LAST_TEXT_X : x;
          const anchor = last ? "end" : "middle";
          return `<circle cx="${x}" cy="180" r="8" fill="${ACCENT}"/>` +
            text(tx, 150, label, 15, INK, anchor, "700") +
            text(tx, 214, sub, 12, MUTED, anchor);
        })
        .join("") +
      text(24, 300, "※期限の数え方は、手続きや制度によって異なります", 13, MUTED),
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
  // ↓ 以下3つは公開LPでは renderFigureHtml(絵や本文と組む HTML)で描く。SVG は管理画面の見本(縮小表示)用。
  sell_rent_keep: () =>
    wrap(
      LP_BRAND.options.map((o, i) => {
        const x = 24 + i * 204;
        return `<rect x="${x}" y="84" width="184" height="180" rx="12" fill="${SOFT}" stroke="${ACCENT}" stroke-width="1.5"/>` +
          text(x + 92, 190, o.title, 20, INK, "middle", "700");
      }).join("") + text(24, 310, "それぞれの見通しをお伝えします(絵つき)", 13, MUTED),
      FIGURE_LABELS.sell_rent_keep,
    ),
  partner_network: () =>
    wrap(
      `<rect x="200" y="70" width="240" height="44" rx="22" fill="${ACCENT}"/>` + text(320, 98, "当社の相談窓口", 16, "#ffffff", "middle", "700") +
      `<path d="M320 114v26M112 140h416M112 140v20M320 140v20M528 140v20" stroke="${ACCENT}" stroke-width="2" fill="none"/>` +
      ([["司法書士・税理士", 112], ["弁護士・調査士", 320], ["片付け・引越・内装", 528]] as const).map(([t, x]) =>
        `<rect x="${x - 88}" y="162" width="176" height="44" rx="10" fill="${SOFT}" stroke="${ACCENT}" stroke-width="1.5"/>` + text(x, 190, t, 14, INK, "middle", "700"),
      ).join("") +
      text(24, 300, "提携の専門家・業者へ当社からおつなぎします", 13, MUTED),
      FIGURE_LABELS.partner_network,
    ),
  consult_guide: () =>
    wrap(
      `<rect x="24" y="80" width="160" height="160" rx="14" fill="${SOFT}" stroke="${ACCENT}" stroke-width="1.5"/>` +
      text(104, 166, "案内役の絵", 14, ACCENT, "middle", "700") +
      `<rect x="208" y="96" width="400" height="14" rx="7" fill="${SOFT}"/><rect x="208" y="128" width="360" height="14" rx="7" fill="${SOFT}"/><rect x="208" y="160" width="380" height="14" rx="7" fill="${SOFT}"/>` +
      text(24, 300, "この節の見出しと文章を、案内役の横に並べます", 13, MUTED),
      FIGURE_LABELS.consult_guide,
    ),
};

export function renderFigureSvg(kind: FigureKind): string {
  return RENDERERS[kind]();
}

// ───────────── 公開LP用の HTML 版(2026-10 見本どおりの作り) ─────────────
// SVG の図は文字が小さくなり「安っぽい」との指摘(2026-10-05 発注者)。文字が要る図は HTML で組み、
// CSS(lp-page.ts)で整える。中身は固定文=決定的(動的な値は持たないが、念のため esc を通す)。
// ⚠期限の図の文言は 2026-10-06 の事実確認(国税庁 No.3306/4205・法務省 相続登記の義務化・国交省 空き家特例)
//   に合わせたもの。「3年目の年末」のような1年ずれて読める短縮は使わない。制度が変わったら直す。

const DEADLINE_ITEMS: Array<{ when: string; title: string; notes: string[]; key?: boolean }> = [
  { when: "相続の<br>開始", title: "亡くなった日", notes: ["期限の数え方は、手続きや制度によって異なります"] },
  { when: "原則<br>10か月以内", title: "相続税の申告・納付", notes: ["亡くなったことを知った日の翌日から。特例で税額がゼロになる場合も、申告が必要なことがあります"] },
  {
    when: "原則<br>3年以内",
    title: "相続登記(名義変更)の申請",
    notes: [
      "相続の開始と、その不動産を取得したことの両方を知った日から。2024年4月1日から義務になりました",
      "※2024年4月1日より前に相続し、取得したことも知っていた不動産は、原則2027年3月31日までに申請が必要です",
    ],
  },
  {
    when: "売却期限",
    title: "空き家の特例を使うための売却期限",
    notes: [
      "相続開始から3年を経過する日の属する年の12月31日まで。あわせて、今の制度では2027年12月31日までの売却が対象です(早い方が期限)",
      "条件を満たせば、売却益から1人あたり最大3,000万円を差し引けます。対象の家と土地の両方を相続した人が3人以上なら、1人あたり最大2,000万円です",
    ],
    key: true,
  },
];
const DEADLINE_FOOTNOTE = "※空き家の特例には、1981年5月31日以前に建てられた家であること、相続前後の使い方、売却額、耐震基準に合わせる工事または解体などの条件があり、使うには確定申告が必要です。2026年10月時点の制度にもとづいています。";

const FLOW_STEPS: Array<[string, string]> = [
  ["ご相談・無料査定", "お手紙の物件について、おおよその価格の目安をお伝えします"],
  ["ご家族での話し合い", "査定の結果を材料に、売るかどうかを決めていただきます。急かしません"],
  ["販売のご依頼", "売ると決めた場合に、販売をお任せいただく契約を結びます"],
  ["販売活動・ご契約", "買主を探し、条件がまとまれば売買契約を結びます"],
  ["お引き渡し", "代金を受け取り、鍵をお渡しして完了です"],
];

/** 会社固有の静的画像(public/lp-assets/brand/)。元の縦横比のまま(width/height=実寸・CSS は height:auto)。 */
function brandImg(image: LpBrandImage, cls: string): string {
  return `<img class="${cls}" src="${esc(image.src)}" width="${image.width}" height="${image.height}" alt="${esc(image.alt)}" loading="lazy" decoding="async" />`;
}

/**
 * 「窓口はひとつ」の図(発注者要望 2026-10-07): リガーレジャパンを真ん中の円に、提携先7つを
 * 周りに並べ、真ん中から1本ずつ線でつなぐ。専門家/業者の色分けはしない(発注者指定)。
 * 配置は計算で決めた固定値: ①真ん中の円から各札までのすき間をどれも36にそろえ(線の見える長さが同じ)、
 * ②そのうえで隣り合う札どうしのすき間がそろう角度を選んだ(どこも約44・ばらつき約1)。
 * 長い札(土地家屋調査士)は上、文字数の近い札を左右対称に置く。外側の余白は上下左右とも約12。
 * ⚠提携先の名前(LP_BRAND.partners)を変えたら、この表も作り直す(テストが名前の一致を確かめる)。
 */
export const NETWORK_VIEW = { w: 403, h: 290 } as const;
export const NETWORK_PILL_H = 36;
const NET_FONT = 15;
export const NETWORK_HUB = { x: 209, y: 146, r: 62 } as const;
const NET_CX = NETWORK_HUB.x;
const NET_CY = NETWORK_HUB.y;
const NET_CENTER_R = NETWORK_HUB.r;
const NETWORK_LAYOUT: ReadonlyArray<{ label: string; x: number; y: number }> = [
  { label: "土地家屋調査士", x: 209, y: 30 },
  { label: "司法書士", x: 347, y: 101 },
  { label: "税理士", x: 342, y: 179 },
  { label: "引っ越し業者", x: 289, y: 260 },
  { label: "内装工事業者", x: 129, y: 260 },
  { label: "弁護士", x: 76, y: 179 },
  { label: "片付け業者", x: 64, y: 99 },
];
export function partnerNetworkNodes(): Array<{ label: string; x: number; y: number; w: number }> {
  return NETWORK_LAYOUT.map((n) => ({ ...n, w: n.label.length * NET_FONT + 28 }));
}
function partnerRadialSvg(): string {
  const nodes = partnerNetworkNodes();
  const lines = nodes.map((n) => `<line x1="${NET_CX}" y1="${NET_CY}" x2="${n.x}" y2="${n.y}" stroke="#0e6b5c" stroke-width="2"/>`).join("");
  const pills = nodes.map((n) =>
    `<rect x="${n.x - n.w / 2}" y="${n.y - NETWORK_PILL_H / 2}" width="${n.w}" height="${NETWORK_PILL_H}" rx="${NETWORK_PILL_H / 2}" fill="#e3efe9" stroke="#0e6b5c" stroke-width="1.5"/>` +
    `<text x="${n.x}" y="${n.y + 5}" ${FONT} font-size="${NET_FONT}" font-weight="700" fill="#0a5246" text-anchor="middle">${esc(n.label)}</text>`,
  ).join("");
  const center = `<circle cx="${NET_CX}" cy="${NET_CY}" r="${NET_CENTER_R}" fill="#0e6b5c"/>` +
    `<text x="${NET_CX}" y="${NET_CY - 6}" ${FONT} font-size="17" font-weight="700" fill="#fffdf8" text-anchor="middle">リガーレ</text>` +
    `<text x="${NET_CX}" y="${NET_CY + 16}" ${FONT} font-size="17" font-weight="700" fill="#fffdf8" text-anchor="middle">ジャパン</text>` +
    `<text x="${NET_CX}" y="${NET_CY + 36}" ${FONT} font-size="11" fill="#e3efe9" text-anchor="middle">ご相談窓口</text>`;
  const label = `リガーレジャパンを中心に、${nodes.map((n) => n.label).join("・")}とつながっています`;
  return `<svg class="net-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${NETWORK_VIEW.w} ${NETWORK_VIEW.h}" width="${NETWORK_VIEW.w}" height="${NETWORK_VIEW.h}" role="img" aria-label="${esc(label)}">${lines}${center}${pills}</svg>`;
}

/** 公開LPに埋める図の HTML。consult_guide は節の本文と組むため lp-page.ts 側で並べる(ここは絵の部分だけ)。 */
export function renderFigureHtml(kind: FigureKind): string {
  switch (kind) {
    case "inheritance_deadlines":
      return `<div class="deadline" role="group" aria-label="${esc(FIGURE_LABELS.inheritance_deadlines)}"><ol class="dl-list">` +
        DEADLINE_ITEMS.map((d) =>
          `<li class="dl-item${d.key ? " key" : ""}"><div class="dl-when">${d.when}</div><div class="dl-what"><strong>${esc(d.title)}</strong>` +
          d.notes.map((n) => `<span>${esc(n)}</span>`).join("") + `</div></li>`,
        ).join("") +
        `</ol><p class="small-note">${esc(DEADLINE_FOOTNOTE)}</p></div>`;
    case "sale_flow":
      return `<div class="flow-box"><ol class="flow">` +
        FLOW_STEPS.map(([t, s]) => `<li><div><strong>${esc(t)}</strong><span>${esc(s)}</span></div></li>`).join("") +
        `</ol><p class="flow-total">ご相談からお引き渡しまで、3〜6か月ほどが目安です</p><p class="small-note">期間は物件やご希望の条件によって変わります。</p></div>`;
    case "sell_rent_keep":
      return `<div class="options">` +
        LP_BRAND.options.map((o) => `<div class="opt-card">${brandImg(o.image, "opt-img")}<h3>${esc(o.title)}</h3><p>${esc(o.text)}</p></div>`).join("") +
        `</div>`;
    case "partner_network":
      return `<div class="network">${partnerRadialSvg()}` +
                `<p class="small-note">必要なときに、提携の専門家・業者へ当社からおつなぎします。</p></div>`;
    case "consult_guide":
      return `<figure class="guide-fig">${brandImg(LP_BRAND.guide, "guide-img")}<figcaption>イメージ<br />イラスト</figcaption></figure>`;
    default:
      // 横棒などの図は従来の SVG をそのまま(枠つきで)載せる。
      return `<div class="fig-svg">${renderFigureSvg(kind)}</div>`;
  }
}
